import { useEffect, useState } from "react";
import type { FormEvent } from "react";

export type OrderDraft = {
  ticker: string;
  side: "YES" | "NO";
  count: number;
  price: number;
  edge: number | null;
  title?: string;
};

type Pick = {
  id: string;
  tab: string;
  model: string;
  side: string;
  price: number;
  fair_prob: number | null;
  fair_prob_source?: string;
  proxy_label?: string;
  verdict: string;
  watch_trigger?: string;
  edge: { cents_per_contract_after_fees: number; fee_dollars?: number };
  stake_suggestion: { contracts: number; cost_dollars: number; method: string };
  market: { title: string; ticker?: string; close_time_et?: string; kalshi_shard?: number };
  data_timestamps: Record<string, string>;
  unverified?: string[];
  summary: string[];
  depth?: number | null;
};

type ScanPayload = {
  empty?: boolean;
  stale?: boolean;
  startedAt?: string;
  finishedAt?: string;
  pass?: Pick[];
  watch?: Pick[];
  saved?: Pick[];
  coverage?: Array<{ tab: string; status: string; model: string }>;
  errors?: string[];
  timestamps?: Record<string, string>;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function ageLabel(iso?: string, liveMs = 60_000): "STALE" | "fresh" | "—" {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  return Date.now() - ts > liveMs ? "STALE" : "fresh";
}

function PickCard({ pick, onPrepare }: { pick: Pick; onPrepare?: (draft: OrderDraft) => void }) {
  const stamps = Object.entries(pick.data_timestamps || {});
  const stale = (pick.unverified || []).includes("STALE") || stamps.some(([, iso]) => ageLabel(iso, pick.tab === "Crypto" ? 60_000 : 5 * 60_000) === "STALE");
  return (
    <article className={`pick-card ${pick.verdict === "PASS" ? "pass" : "watch"}`} data-testid={`pick-${pick.verdict}`}>
      <header>
        <strong>{pick.verdict}</strong>
        <span>{pick.tab}</span>
        {stale && <span className="stale-tag">STALE</span>}
      </header>
      <h3>{pick.market.title}</h3>
      <p className="ticker">{pick.market.ticker} · {pick.side} @ {pick.price || "—"} · shard {pick.market.kalshi_shard ?? "—"}</p>
      <p>{pick.summary?.[1]}</p>
      <p className="proxy">{pick.proxy_label || pick.fair_prob_source}</p>
      <p>Edge {pick.edge.cents_per_contract_after_fees}¢ after fees · stake {pick.stake_suggestion.contracts ? `${pick.stake_suggestion.contracts} contracts ($${pick.stake_suggestion.cost_dollars.toFixed(2)})` : pick.stake_suggestion.method}</p>
      {pick.watch_trigger && <p className="trigger">WATCH: {pick.watch_trigger}</p>}
      <ul className="stamps">
        {stamps.map(([name, iso]) => {
          const state = ageLabel(iso, pick.model === "crypto lognormal" ? 60_000 : 5 * 60_000);
          return <li key={name}>{name}: {iso} {state === "STALE" ? "· STALE" : ""}</li>;
        })}
      </ul>
      <p className="needs-yes">Needs your yes. Closes {pick.market.close_time_et || "—"}.</p>
      {pick.verdict === "PASS" && pick.market.ticker && pick.side !== "none" && onPrepare && (
        <button className="button-secondary" type="button" onClick={() => onPrepare({
          ticker: pick.market.ticker || "",
          side: pick.side === "NO" ? "NO" : "YES",
          count: Math.max(1, pick.stake_suggestion.contracts || 1),
          price: pick.price,
          edge: pick.edge.cents_per_contract_after_fees,
          title: pick.market.title,
        })}>Prepare this exact trade</button>
      )}
    </article>
  );
}

export function HourlySection({ onPrepare }: { onPrepare: (draft: OrderDraft) => void }) {
  const [scan, setScan] = useState<ScanPayload | null>(null);
  const [history, setHistory] = useState<string[][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const [latest, log] = await Promise.all([
      getJson<ScanPayload>("/api/desk/scan/latest"),
      getJson<{ rows: string[][] }>("/api/desk/scan/history"),
    ]);
    setScan(latest);
    setHistory(log.rows || []);
  };

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Scan unavailable"));
  }, []);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const report = await fetch("/api/desk/scan", { method: "POST" }).then(async (res) => {
        if (!res.ok) throw new Error(`Scan HTTP ${res.status}`);
        return res.json() as Promise<ScanPayload>;
      });
      setScan(report);
      const log = await getJson<{ rows: string[][] }>("/api/desk/scan/history");
      setHistory(log.rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  };

  const scanStale = scan?.stale || (scan?.finishedAt ? Date.now() - Date.parse(scan.finishedAt) > 70 * 60_000 : false);
  return (
    <main className="main" data-testid="section-hourly">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Every hour · America/New_York</div>
          <h1>Hourly picks</h1>
          <p>PASS needs 2¢ of edge after the taker fee and depth at the ask. The scan never places a bet.</p>
        </div>
        <button className="button-primary" type="button" onClick={() => void run()} disabled={busy}>{busy ? "Scanning" : "Run Scan"}</button>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="scan-meta">
        <span>{scan?.finishedAt ? `Last scan ${scan.finishedAt}` : "No scan yet"}</span>
        {scanStale && <span className="stale-tag">STALE</span>}
      </div>
      {scan?.errors && scan.errors.length > 0 && <p className="data-note">{scan.errors.slice(0, 4).join(" · ")}</p>}
      <section className="panel">
        <div className="panel-head"><div className="panel-title">PASS · needs your yes</div></div>
        <div className="pick-grid">{(scan?.pass || []).length ? scan!.pass!.map((pick) => <PickCard key={pick.id} pick={pick} onPrepare={onPrepare} />) : <div className="placeholder">No PASS picks in the latest scan.</div>}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><div className="panel-title">WATCH</div><div className="panel-kicker">Flag stays on the line</div></div>
        <div className="pick-grid">{(scan?.watch || []).length ? scan!.watch!.map((pick) => <PickCard key={pick.id} pick={pick} />) : <div className="placeholder">No WATCH rows.</div>}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><div className="panel-title">Still good</div></div>
        <div className="pick-grid">{(scan?.saved || []).length ? scan!.saved!.map((pick) => <PickCard key={`saved-${pick.id}`} pick={pick} onPrepare={onPrepare} />) : <div className="placeholder">No saved pick is still a PASS.</div>}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><div className="panel-title">Coverage</div></div>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Tab</th><th>Model</th><th>Status</th></tr></thead><tbody>{(scan?.coverage || []).map((row) => <tr key={row.tab}><td>{row.tab}</td><td>{row.model}</td><td>{row.status}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel">
        <div className="panel-head"><div className="panel-title">History log</div><div className="panel-kicker">Append-only · FAIL rows are logged, not suggested</div></div>
        <div className="table-wrap"><table className="data-table"><tbody>{history.slice(0, 40).map((row, index) => <tr key={index}><td>{row[0]}</td><td>{row[1]}</td><td>{row[3]}</td><td>{row[4]}</td><td>{row[7]}¢</td><td>{row[10]}</td></tr>)}</tbody></table></div>
      </section>
    </main>
  );
}

export function ArbSection() {
  const [state, setState] = useState<{ needsKey?: boolean; error?: string; rows?: Array<Record<string, unknown>>; scannedAt?: string } | null>(null);
  useEffect(() => {
    void getJson<typeof state>("/api/desk/arb").then(setState).catch(() => setState({ needsKey: true, error: "Arb lookup failed." }));
  }, []);
  return (
    <main className="main" data-testid="section-arb">
      <div className="page-heading"><div><div className="eyebrow">Kalshi versus sportsbooks</div><h1>Sports arbitrage</h1><p>A PASS needs 1.5% after the Kalshi fee, fresh lines, and both outcomes covered. Nothing here places a bet.</p></div></div>
      {state?.needsKey && (
        <section className="panel needs-key" data-testid="arb-needs-key">
          <div className="panel-head"><div className="panel-title">Needs a key</div></div>
          <p>Set <code>ODDS_API_KEY</code> in the server environment. The free tier of The Odds API is enough to start. No sportsbook lines are shown until that key is present.</p>
        </section>
      )}
      {!state?.needsKey && (
        <section className="panel">
          <div className="panel-head"><div className="panel-title">Candidates</div><div className="panel-kicker">{state?.scannedAt || ""}</div></div>
          {state?.error && <p className="data-note">{state.error}</p>}
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Market</th><th>Kalshi</th><th>Book</th><th>Return</th><th>Verdict</th></tr></thead><tbody>
            {(state?.rows || []).map((row) => <tr key={String(row.ticker)}><td>{String(row.title)}<br />{String(row.ticker)}</td><td>{String(row.side)} @ {String(row.kalshiPrice)}</td><td>{String(row.book)} vs {String(row.otherTeam)}{row.stale ? " · STALE" : ""}</td><td>{String(row.returnPct)}%</td><td>{String(row.verdict)} · {String(row.reason)}</td></tr>)}
          </tbody></table></div>
          {(state?.rows || []).length === 0 && <div className="placeholder">No arb above the noise floor.</div>}
        </section>
      )}
    </main>
  );
}

export function AssistantSection() {
  const [needsKey, setNeedsKey] = useState(false);
  const [log, setLog] = useState<Array<{ role: string; content: string }>>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getJson<{ xai: boolean }>("/api/desk/status").then((status) => setNeedsKey(!status.xai)).catch(() => setNeedsKey(true));
  }, []);
  const send = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setBusy(true);
    setLog((rows) => [...rows, { role: "you", content: trimmed }]);
    setText("");
    try {
      const res = await fetch("/api/desk/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: trimmed }) });
      const data = await res.json() as { reply?: string; needsKey?: boolean };
      if (data.needsKey) setNeedsKey(true);
      setLog((rows) => [...rows, { role: "desk", content: data.reply || "No reply" }]);
    } catch (error) {
      setLog((rows) => [...rows, { role: "desk", content: error instanceof Error ? error.message : "Chat failed" }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="main" data-testid="section-assistant">
      <div className="page-heading"><div><div className="eyebrow">Playbook rules · xAI</div><h1>Assistant</h1><p>It can explain a pick or run a scan. It cannot approve a bet, even if a password is typed here.</p></div></div>
      {needsKey && <section className="panel needs-key" data-testid="assistant-needs-key"><div className="panel-head"><div className="panel-title">Needs a key</div></div><p>Set <code>XAI_API_KEY</code> to talk to the model. You can still run a scan from this box; the reply will be the scan summary.</p></section>}
      <section className="panel chat-panel">
        <div className="chat-log" data-testid="chat-log">{log.length === 0 && <div className="placeholder">Ask why a pick is a PASS, or tell it to run a scan.</div>}{log.map((row, index) => <p key={index} className={row.role === "you" ? "chat-you" : "chat-desk"}><strong>{row.role}</strong> {row.content}</p>)}</div>
        <form className="chat-form" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
          <input className="input" aria-label="Message the assistant" value={text} onChange={(event) => setText(event.target.value)} placeholder="Explain the latest BTC pick" />
          <button className="button-primary" type="submit" disabled={busy}>Send</button>
          <button className="button-secondary" type="button" disabled={busy} onClick={() => void send("Run scan")}>Run scan</button>
        </form>
      </section>
    </main>
  );
}

export function OrdersSection({ draft }: { draft: OrderDraft | null }) {
  const [ticker, setTicker] = useState(draft?.ticker || "");
  const [side, setSide] = useState<"YES" | "NO">(draft?.side || "YES");
  const [count, setCount] = useState(String(draft?.count || 1));
  const [price, setPrice] = useState(String(draft?.price || ""));
  const [edge, setEdge] = useState<number | null>(draft?.edge ?? null);
  const [ack, setAck] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [log, setLog] = useState<Array<Record<string, unknown>>>([]);
  const [status, setStatus] = useState<{ kalshiKey?: boolean; approvalPassword?: boolean } | null>(null);

  useEffect(() => {
    if (!draft) return;
    setTicker(draft.ticker);
    setSide(draft.side);
    setCount(String(draft.count));
    setPrice(String(draft.price));
    setEdge(draft.edge);
    setConfirm(false);
    setResult(null);
  }, [draft]);

  useEffect(() => {
    void getJson<{ kalshiKey: boolean; approvalPassword: boolean }>("/api/desk/status").then(setStatus).catch(() => setStatus(null));
    void getJson<{ orders: Array<Record<string, unknown>> }>("/api/desk/orders/log").then((data) => setLog(data.orders || [])).catch(() => undefined);
  }, [result]);

  const previewTrade = async () => {
    setResult(null);
    const res = await fetch("/api/desk/orders/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, side, count: Number(count), price: Number(price) }),
    });
    const data = await res.json() as Record<string, unknown>;
    setPreview(data);
    if (typeof data.acknowledgedPrice === "number") setAck(data.acknowledgedPrice);
  };

  const place = async (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    const res = await fetch("/api/desk/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm,
        password,
        ticker,
        side,
        count: Number(count),
        price: Number(price),
        acknowledgedPrice: ack ?? Number(price),
        acknowledgedEdge: edge,
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    setResult(data);
    if (data.code === "price_moved" || data.code === "edge_moved") {
      const fresh = data.fresh as { ask?: number; edge_cents?: number } | undefined;
      if (fresh?.ask) {
        setPrice(String(fresh.ask));
        setAck(fresh.ask);
      }
      if (typeof fresh?.edge_cents === "number") setEdge(fresh.edge_cents);
      setConfirm(false);
      setPassword("");
    } else {
      setPassword("");
      setConfirm(false);
    }
  };

  const fresh = result?.fresh as { ask?: number; edge_cents?: number | null; depth?: number } | undefined;
  return (
    <main className="main" data-testid="section-orders">
      <div className="page-heading"><div><div className="eyebrow">Explicit confirmation</div><h1>Place bet</h1><p>One order, the exact market and amount you confirm, plus the approval password. A wrong or missing password places nothing. Cash is not moved between shards.</p></div></div>
      {status && (!status.kalshiKey || !status.approvalPassword) && (
        <section className="panel needs-key"><p>{!status.kalshiKey && "KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PEM are not both set. "}{!status.approvalPassword && "MONEY_DESK_APPROVAL_PASSWORD is not set. "}Nothing can be placed until those are set on the server.</p></section>
      )}
      <section className="panel">
        <form className="order-form" onSubmit={place}>
          <label>Ticker<input className="input" aria-label="Ticker" value={ticker} onChange={(event) => setTicker(event.target.value)} /></label>
          <label>Side<select className="input" aria-label="Side" value={side} onChange={(event) => setSide(event.target.value === "NO" ? "NO" : "YES")}><option>YES</option><option>NO</option></select></label>
          <label>Contracts<input className="input" aria-label="Order contracts" value={count} onChange={(event) => setCount(event.target.value)} /></label>
          <label>Limit price<input className="input" aria-label="Limit price" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
          <button className="button-secondary" type="button" onClick={() => void previewTrade()}>Preview quote</button>
          {preview && <div className="preview-box" data-testid="order-preview"><p>Live ask {String(preview.acknowledgedPrice)} · fee ${String(preview.fee_dollars)} · cost ${String(preview.cost_dollars)}</p><p>Shard {String(preview.exchange_index)} ({String(preview.shard_label)}) cash {preview.shard_cash == null ? "unread" : `$${preview.shard_cash}`}. {String(preview.transfer || "")}</p></div>}
          <label className="confirm-line"><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} /> I confirm this exact trade: {side} {count} of {ticker || "—"} at {price || "—"}.</label>
          <label>Approval password<input className="input" aria-label="Approval password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="button-primary" type="submit" disabled={!confirm || password.length === 0}>Place this order</button>
        </form>
        {result && <div className={`order-result ${result.ok ? "pass" : "watch"}`} role="alert" data-testid="order-result">{result.ok ? `Placed. ${JSON.stringify(result.order)}` : String(result.error)}{fresh ? ` New ask ${fresh.ask}. New edge ${fresh.edge_cents ?? "—" }¢. Depth ${fresh.depth ?? "—"}. Check the box again to confirm the new price.` : ""}</div>}
      </section>
      <section className="panel">
        <div className="panel-head"><div className="panel-title">Order log</div></div>
        <div className="table-wrap"><table className="data-table"><tbody>{log.map((row, index) => <tr key={index}><td>{String(row.at || "")}</td><td>{String(row.ticker || "")}</td><td>{String(row.code || "")}</td><td>{String(row.error || row.http_status || "")}</td></tr>)}</tbody></table></div>
      </section>
    </main>
  );
}

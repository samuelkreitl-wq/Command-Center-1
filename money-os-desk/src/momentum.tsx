import { useCallback, useEffect, useState } from "react";

/**
 * Read-only "Outside / Momentum bot" panel. It calls GET /api/desk/outside only.
 * There is no button here that places, cancels, amends, transfers, pauses or revokes anything.
 */

type Row = Record<string, unknown>;
type Outside = {
  needsKey?: boolean;
  error?: string;
  checkedAt?: string;
  windowHours?: number;
  momentumPrefix?: string | null;
  note?: string;
  logic?: string[];
  fingerprint?: { orders: number; marketOrders: number; limitOrders: number; fractionalSizes: number; takeProfitSellWithin2MinOfBuy: number; transfersSameSecondAsOrder: number; series: Array<{ name: string; count: number }> };
  openPositions?: Row[];
  restingOrders?: Row[];
  orders?: Row[];
  fills?: Row[];
  unattributedFills?: number;
  settled?: Row[];
  transfers?: Row[];
  deskTransfers?: number;
  pnl?: { settled: number; openAtBid: number | null; total: number | null };
  errors?: string[];
};

const et = (iso: unknown) => {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) + " ET" : "—";
};
const usd = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v) < 0 ? "−" : ""}$${Math.abs(Number(v)).toFixed(2)}`);
const cents = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? "—" : `${Math.round(Number(v) * 100)}¢`);
const tone = (v: unknown) => (v == null ? "" : Number(v) >= 0 ? "result-good" : "result-bad");

function Metric({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return <div className="metric"><div className="metric-label">{label}</div><div className={`metric-value ${className}`}>{value}</div></div>;
}

export function MomentumSection() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<Outside | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/desk/outside?hours=${hours}`, { headers: { Accept: "application/json" } });
      setData(await res.json() as Outside);
    } catch {
      setData({ error: "Could not reach the Command Center server." });
    } finally {
      setBusy(false);
    }
  }, [hours]);
  useEffect(() => { void load(); }, [load]);

  const fp = data?.fingerprint;
  return (
    <main className="main" data-testid="section-outside">
      <div className="page-heading">
        <div><div className="eyebrow">Read-only · other keys and apps</div><h1>Outside activity / momentum bot</h1><p>Everything on the account that this desk did not send: orders with an empty client_order_id, the positions and fills they made, and shard transfers with no client_transfer_id. Nothing here can trade, cancel, move money, pause, or revoke a key.</p></div>
        <div className="time-stamp">
          <label>WINDOW <select value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value={24}>24h</option><option value={72}>72h</option><option value={168}>7d</option></select></label><br />
          <button className="refresh-button" onClick={() => void load()} disabled={busy}>{busy ? "Checking…" : "Refresh"}</button><br />
          {data?.checkedAt ? `CHECKED ${et(data.checkedAt)}` : ""}
        </div>
      </div>

      {data?.needsKey && <section className="panel needs-key"><div className="panel-head"><div className="panel-title">Needs Kalshi keys</div></div><p>Set <code>KALSHI_API_KEY_ID</code> and <code>KALSHI_PRIVATE_KEY_PEM</code> on the server. This panel only reads.</p></section>}
      {data?.error && <p className="data-note">{data.error}</p>}

      {data && !data.needsKey && !data.error && <div className="column reveal">
        <section className="panel">
          <div className="panel-head"><div className="panel-title">Outside P&amp;L, last {data.windowHours}h</div><div className="panel-kicker">{data.momentumPrefix ? `Momentum tag: ${data.momentumPrefix}` : "No momentum tag known"}</div></div>
          <div className="contract-metrics" style={{ margin: 16 }}>
            <Metric label="Settled" value={usd(data.pnl?.settled)} className={tone(data.pnl?.settled)} />
            <Metric label="Open, at bid" value={usd(data.pnl?.openAtBid)} className={tone(data.pnl?.openAtBid)} />
            <Metric label="Total" value={usd(data.pnl?.total)} className={tone(data.pnl?.total)} />
          </div>
          <p className="data-note" style={{ padding: "0 20px 14px" }}>{data.note}</p>
        </section>

        <section className="panel">
          <div className="panel-head"><div className="panel-title">What we know about its logic</div></div>
          <ul className="data-note" style={{ padding: "8px 36px 4px" }}>{(data.logic || []).map((line) => <li key={line}>{line}</li>)}</ul>
          {fp && <div className="contract-metrics" style={{ margin: 16 }}>
            <Metric label="Outside orders" value={String(fp.orders)} />
            <Metric label="Market / limit" value={`${fp.marketOrders} / ${fp.limitOrders}`} />
            <Metric label="Fractional sizes" value={String(fp.fractionalSizes)} />
            <Metric label="Sell limit ≤2 min after buy" value={String(fp.takeProfitSellWithin2MinOfBuy)} />
            <Metric label="Auto-funded same second" value={String(fp.transfersSameSecondAsOrder)} />
            <Metric label="Series" value={fp.series.map((s) => `${s.name}×${s.count}`).join(" · ") || "—"} />
          </div>}
        </section>

        <section className="panel table-panel">
          <div className="panel-head"><div className="panel-title">Open outside positions</div><div className="panel-kicker">{(data.openPositions || []).length}</div></div>
          {(data.openPositions || []).length === 0 ? <div className="placeholder">No open position traced to an outside order.</div> :
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Market</th><th>Side</th><th>Contracts</th><th>Avg</th><th>Cost</th><th>Bid</th><th>Value</th><th>P&amp;L at bid</th><th>Origin</th></tr></thead><tbody>
              {(data.openPositions || []).map((p) => <tr key={String(p.ticker)}><td className="table-primary">{String(p.title || "")}<br /><span style={{ color: "#8b95a1" }}>{String(p.ticker)}</span></td><td>{String(p.side)}</td><td>{String(p.contracts)}</td><td>{cents(p.avgPrice)}</td><td>{usd(p.cost)}</td><td>{cents(p.bid)}</td><td>{usd(p.value)}</td><td className={tone(p.unrealized)}>{usd(p.unrealized)}</td><td>{String(p.origin)}</td></tr>)}
            </tbody></table></div>}
        </section>

        <section className="panel table-panel">
          <div className="panel-head"><div className="panel-title">Resting outside orders</div><div className="panel-kicker">{(data.restingOrders || []).length}</div></div>
          {(data.restingOrders || []).length === 0 ? <div className="placeholder">None resting.</div> :
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Placed</th><th>Market</th><th>Order</th><th>Limit</th><th>Remaining</th><th>Shard</th></tr></thead><tbody>
              {(data.restingOrders || []).map((o, i) => <tr key={i}><td>{et(o.createdAt)}</td><td>{String(o.ticker)}</td><td>{String(o.verb)} · {String(o.type)}</td><td>{cents(o.price)}</td><td>{String(o.remaining)}</td><td>{String(o.shard)}</td></tr>)}
            </tbody></table></div>}
          <p className="data-note" style={{ padding: "0 20px 14px" }}>On a netted account a resting "sell YES" with no YES left opens a NO position if it fills.</p>
        </section>

        <section className="panel table-panel">
          <div className="panel-head"><div className="panel-title">Outside orders in window</div><div className="panel-kicker">{(data.orders || []).length}</div></div>
          {(data.orders || []).length === 0 ? <div className="placeholder">No outside orders in this window.</div> :
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Placed</th><th>Market</th><th>Order</th><th>Limit/cap</th><th>Size</th><th>Filled</th><th>Status</th></tr></thead><tbody>
              {(data.orders || []).map((o, i) => <tr key={i}><td>{et(o.createdAt)}</td><td>{String(o.ticker)}</td><td>{String(o.verb)} · {String(o.type)}</td><td>{cents(o.price)}</td><td>{String(o.count)}</td><td>{String(o.filled)}</td><td>{String(o.status)}</td></tr>)}
            </tbody></table></div>}
        </section>

        <section className="panel table-panel">
          <div className="panel-head"><div className="panel-title">Outside fills</div><div className="panel-kicker">{(data.fills || []).length}{data.unattributedFills ? ` · ${data.unattributedFills} fills had no matching order` : ""}</div></div>
          {(data.fills || []).length === 0 ? <div className="placeholder">No outside fills in this window.</div> :
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Time</th><th>Market</th><th>Action</th><th>Contracts</th><th>YES price</th><th>Fee</th></tr></thead><tbody>
              {(data.fills || []).map((f, i) => <tr key={i}><td>{et(f.createdAt)}</td><td>{String(f.ticker)}</td><td>{String(f.action)} {String(f.side).toUpperCase()}{f.taker ? " · taker" : " · maker"}</td><td>{String(f.count)}</td><td>{cents(f.yesPrice)}</td><td>{usd(f.fee)}</td></tr>)}
            </tbody></table></div>}
        </section>

        <section className="panel table-panel">
          <div className="panel-head"><div className="panel-title">Settled outside markets</div><div className="panel-kicker">{(data.settled || []).length}</div></div>
          {(data.settled || []).length === 0 ? <div className="placeholder">Nothing outside settled in this window.</div> :
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Settled</th><th>Market</th><th>Result</th><th>P&amp;L</th><th>Origin</th></tr></thead><tbody>
              {(data.settled || []).map((s, i) => <tr key={i}><td>{et(s.settledAt)}</td><td>{String(s.ticker)}</td><td>{String(s.result).toUpperCase()}</td><td className={tone(s.pnl)}>{usd(s.pnl)}</td><td>{String(s.origin)}</td></tr>)}
            </tbody></table></div>}
        </section>

        <section className="panel table-panel">
          <div className="panel-head"><div className="panel-title">Shard transfers not from this desk</div><div className="panel-kicker">{(data.transfers || []).length} outside · {data.deskTransfers ?? 0} desk</div></div>
          {(data.transfers || []).length === 0 ? <div className="placeholder">No outside shard transfers in this window.</div> :
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Time</th><th>Amount</th><th>From</th><th>To</th><th>Status</th></tr></thead><tbody>
              {(data.transfers || []).map((t, i) => <tr key={i}><td>{et(t.at)}</td><td>{usd(t.amount)}</td><td>{String(t.from)}</td><td>{String(t.to)}</td><td>{String(t.status)}</td></tr>)}
            </tbody></table></div>}
        </section>

        {(data.errors || []).length > 0 && <p className="data-note">Some reads failed: {(data.errors || []).join(" · ")}</p>}
      </div>}
    </main>
  );
}

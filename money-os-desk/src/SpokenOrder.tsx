import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import ProjectionChart from "./ProjectionChart";
import TimeframeStrip from "./TimeframeStrip";

type Proposal = {
  ok: boolean;
  kind?: string;
  message?: string;
  proposalId?: string;
  orderHash?: string;
  expiresAt?: number;
  order?: { ticker: string; side: string; count: number; limitPrice: number; maxCost: number };
  market?: { ticker: string; openTime?: string; closeTime: string; floorStrike: number | null; yesAsk: number; noAsk: number; status: string };
  spot?: number | null;
  parsed?: { price: number | null; timeLabel: string | null; side: string | null };
  forecast?: { point: number; band68: [number, number]; band90: [number, number]; probabilityAbove: number | null; method: string };
  edge?: { yes: number; no: number };
  path?: string;
  position?: { ticker: string; side: string; count: number; price: number };
  scenario?: { horizons?: Record<string, { point: number; band90: [number, number]; pointReturn: number; pDrop10: number }> };
  stale?: boolean;
  projection?: { crossings?: { label: string; kind: string; projectedTime: number; level: number }[]; charts?: { points?: { t: number; price: number; low90: number; high90: number }[] }[] };
};

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
};

function money(n: number | null | undefined) {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—";
}

export default function SpokenOrder() {
  const [text, setText] = useState("");
  const [count, setCount] = useState("1");
  const [listening, setListening] = useState(false);
  const [speechNote, setSpeechNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Proposal | null>(null);
  const [note, setNote] = useState("");

  async function resolve(utterance: string) {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/trade/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ utterance, count: Number(count) || 1 }),
      });
      setResult(await response.json() as Proposal);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not read that.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void resolve(text);
  }

  function listen() {
    const hostWindow = window as unknown as {
      __deskSpeech?: new () => SpeechRec;
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const Host = hostWindow.__deskSpeech || hostWindow.SpeechRecognition || hostWindow.webkitSpeechRecognition;
    if (!Host) {
      setSpeechNote("Speech recognition is not available in this browser. Type the price and close time instead.");
      return;
    }
    const rec = new Host();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (ev) => {
      const heard = ev.results[0][0].transcript;
      setText(heard);
      void resolve(heard);
    };
    rec.onerror = () => setSpeechNote("The microphone did not return a transcript.");
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  }

  async function confirm() {
    if (!result?.proposalId || !result.orderHash) return;
    setBusy(true);
    try {
      const response = await fetch("/api/trade/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: result.proposalId, orderHash: result.orderHash, confirm: true }),
      });
      const body = await response.json() as Proposal & { orderId?: string };
      setResult(body);
      setNote(body.ok ? `Order ${body.orderId || ""} sent once.` : body.message || "Refused.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (result?.proposalId) {
      await fetch("/api/trade/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: result.proposalId }),
      });
    }
    setResult(null);
    setNote("Cancelled. No order was sent.");
  }

  const canOrder = !!(result?.ok && result.kind === "order" && result.proposalId && result.orderHash);
  const chart = result?.projection?.charts?.find((item) => item?.points && item.points.length > 1);

  return (
    <section className="spoken-shell" data-testid="spoken-order">
      <div className="spoken-head">
        <div>
          <div className="eyebrow">Spoken order</div>
          <h2>Name a price and a close</h2>
          <p>1:15 means the window that ends at 1:15 ET. Nothing is sent until you confirm.</p>
        </div>
      </div>
      <TimeframeStrip />
      <form onSubmit={onSubmit} className="spoken-form">
        <label>
          <span>Price and close time</span>
          <input data-testid="utterance" aria-label="Price and close time" value={text} onChange={(event) => setText(event.target.value)} placeholder="74400 1:15 or what's Bitcoin in 3 days?" />
        </label>
        <label>
          <span>Contracts</span>
          <input aria-label="Order contracts" value={count} onChange={(event) => setCount(event.target.value)} inputMode="numeric" />
        </label>
        <button type="button" data-testid="mic" onClick={listen}>{listening ? "Listening" : "Speak"}</button>
        <button type="submit" data-testid="resolve" disabled={busy}>Resolve</button>
      </form>
      {speechNote && <p className="spoken-note">{speechNote}</p>}
      {result?.kind === "horizon" && result.scenario?.horizons && (
        <div data-testid="horizon-result">
          <p className="scenario-label">SCENARIO — not a certainty. {result.stale ? "STALE" : "Fresh"}.</p>
          {Object.entries(result.scenario.horizons).map(([id, row]) => (
            <p key={id}><strong>{id}</strong> {money(row.point)} · 90% {money(row.band90[0])} to {money(row.band90[1])} · {(row.pointReturn * 100).toFixed(1)}%</p>
          ))}
        </div>
      )}
      {result?.market && (
        <div className="spoken-card" data-testid="spoken-result">
          <p>{result.market.ticker}</p>
          <p>Open {result.market.openTime || "—"} · Close {result.market.closeTime}</p>
          <p>Official strike {result.market.floorStrike == null ? "no strike yet" : money(result.market.floorStrike)} · Spot {money(result.spot)} · YES {result.market.yesAsk.toFixed(2)} · NO {result.market.noAsk.toFixed(2)}</p>
          {result.parsed && <p>Heard price {result.parsed.price == null ? "—" : money(result.parsed.price)} at {result.parsed.timeLabel}. Path {result.path || "—"}.</p>}
          {result.forecast && (
            <p data-testid="forecast-method">Scenario point {money(result.forecast.point)}. 68% {money(result.forecast.band68[0])}–{money(result.forecast.band68[1])}. 90% {money(result.forecast.band90[0])}–{money(result.forecast.band90[1])}. P(above strike) {result.forecast.probabilityAbove == null ? "—" : `${(result.forecast.probabilityAbove * 100).toFixed(1)}%`}. {result.forecast.method}</p>
          )}
          {result.edge && <p>Edge vs YES ask {(result.edge.yes * 100).toFixed(1)}¢ · vs NO ask {(result.edge.no * 100).toFixed(1)}¢. A model gap, not a guaranteed edge.</p>}
          {result.order && <p>Proposed {result.order.side.toUpperCase()} · limit {result.order.limitPrice.toFixed(2)} · {result.order.count} contracts · max cost {money(result.order.maxCost)}</p>}
        </div>
      )}
      {result?.position && <p data-testid="position-block">Position already held on {result.position.ticker}. {result.position.side.toUpperCase()} {result.position.count} @ {result.position.price.toFixed(2)}. No order button.</p>}
      {result && !result.ok && <p className="spoken-note" data-testid="spoken-message">{result.message}</p>}
      {canOrder && (
        <div className="spoken-actions">
          <button type="button" data-testid="confirm-order" onClick={() => void confirm()} disabled={busy}>Yes, place this order</button>
          <button type="button" data-testid="cancel-order" onClick={() => void cancel()}>Cancel</button>
        </div>
      )}
      {note && <p className="spoken-note">{note}</p>}
      {chart?.points && <ProjectionChart points={chart.points} crossings={result?.projection?.crossings ?? []} />}
      <HorizonPanel />
    </section>
  );
}

function HorizonPanel() {
  const [body, setBody] = useState<{ stale?: boolean; scenario?: { computedAt?: number; horizons?: Record<string, { point: number; band68: [number, number]; band90: [number, number]; pDrop5: number; pDrop10: number; pDrop20: number; pointReturn: number }> }; message?: string } | null>(null);
  async function load(refresh = false) {
    const response = await fetch("/api/forecast/short", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: refresh }) });
    setBody(await response.json());
  }
  useEffect(() => { void load(false); }, []);
  const headline = body?.scenario?.horizons?.["3d"];
  const age = body?.scenario?.computedAt ? Math.round((Date.now() - body.scenario.computedAt) / 60000) : null;
  return (
    <div className="horizon-panel" data-testid="horizon-panel">
      <div className="spoken-head"><h2>3-day scenario</h2><button type="button" onClick={() => void load(true)}>Refresh scenario</button></div>
      <p className="scenario-label">SCENARIO, not a certainty. {body?.stale ? "STALE" : age == null ? "" : `Age ${age}m`}. Assumptions: daily vol scaled by sqrt(days), drift shrunk and capped.</p>
      {headline && <p>Point {money(headline.point)} ({(headline.pointReturn * 100).toFixed(1)}%). 68% {money(headline.band68[0])}–{money(headline.band68[1])}. 90% {money(headline.band90[0])}–{money(headline.band90[1])}. P(drop ≥5/10/20%) {(headline.pDrop5 * 100).toFixed(0)}% / {(headline.pDrop10 * 100).toFixed(0)}% / {(headline.pDrop20 * 100).toFixed(0)}%.</p>}
      {!headline && <p>{body?.message || "The daily scenario is not ready."}</p>}
    </div>
  );
}

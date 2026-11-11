import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArbSection, AssistantSection, HourlySection, OrdersSection, type OrderDraft } from "./sections";
import { TradeLogSection } from "./trade-log";
import { buildSnapshot, listJournal, listTradeLog, lockFromLive, placePaper, reviseLockedCall, setCustomReference, settleWindow, tenMinuteTick } from "./lib/desk";
import { DESK_POLL_MS, pollDeskFeeds } from "./lib/feeds";
import type { FeedBundle } from "./lib/feeds";
import { windowId } from "./lib/signal-lock";
import type { ContractWindow, CoreLock, Direction, PaperTrade, TradeSide } from "./lib/types";
import { windowNameByEnd } from "./lib/window-name";

type Tab = "desk" | "journal" | "trades";
type Section = "hourly" | "btc" | "arb" | "assistant" | "orders" | "log";

const money = (n: number | null | undefined, digits = 2) =>
  typeof n === "number" && Number.isFinite(n)
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
    : "—";
const dateTime = (value: number | string | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
const minutesText = (closeTime: string) => {
  const remaining = Math.max(0, new Date(closeTime).getTime() - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")}`;
};
const isFreshSpot = (bundle: FeedBundle | null) =>
  !!bundle?.spot &&
  Number.isFinite(bundle.spot.price) &&
  bundle.spot.price > 0 &&
  Date.now() - bundle.spot.ts <= 30_000 &&
  bundle.spot.ts <= Date.now() + 5_000;
const validContract = (contract: ContractWindow | null) =>
  !!contract &&
  contract.market === "15m" &&
  !!contract.ticker &&
  typeof contract.strike === "number" &&
  Number.isFinite(contract.strike) &&
  contract.strike > 0 &&
  Number.isFinite(new Date(contract.closeTime).getTime()) &&
  new Date(contract.closeTime).getTime() > Date.now();
const validQuote = (price: number) => Number.isFinite(price) && price > 0 && price < 1;

function App() {
  const [section, setSection] = useState<Section>("btc");
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const prepare = (next: OrderDraft) => {
    setDraft(next);
    setSection("orders");
  };
  const [tab, setTab] = useState<Tab>("desk");
  const [bundle, setBundle] = useState<FeedBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [journal, setJournal] = useState<CoreLock[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [side, setSide] = useState<TradeSide>("YES");
  const [size, setSize] = useState("1");
  const [customRef, setCustomRef] = useState("");
  const [formError, setFormError] = useState("");
  const [referenceError, setReferenceError] = useState("");
  const [settlementWindowId, setSettlementWindowId] = useState("");
  const [finalPrice, setFinalPrice] = useState("");
  const [settleError, setSettleError] = useState("");
  const [reviseTo, setReviseTo] = useState<Direction>("DOWN");
  const [reviseReason, setReviseReason] = useState("");
  const [reviseError, setReviseError] = useState("");
  const [now, setNow] = useState(Date.now());
  const refreshInFlight = useRef(false);
  const mounted = useRef(false);

  const syncLocalRows = useCallback(() => {
    setJournal(listJournal().slice().sort((a, b) => b.lockedAt - a.lockedAt));
    setTrades(listTradeLog().slice().sort((a, b) => b.openedAt - a.openedAt));
  }, []);

  const refresh = useCallback(async (manual = true) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (manual) setRefreshing(true);
    try {
      const next = await pollDeskFeeds("15m");
      if (!mounted.current) return;
      setBundle(next);
      setErrors(next.errors);
      setLoading(false);
      syncLocalRows();
    } catch (error) {
      if (!mounted.current) return;
      setErrors([error instanceof Error ? error.message : String(error)]);
      setLoading(false);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [syncLocalRows]);

  useEffect(() => {
    mounted.current = true;
    syncLocalRows();
    void refresh(false);
    const poll = setInterval(() => void refresh(false), DESK_POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [syncLocalRows, refresh]);

  const current = useMemo(
    () => bundle ? buildSnapshot(bundle.contract, bundle.spot, bundle.bars, now) : null,
    [bundle, now],
  );
  const contract = bundle?.contract ?? null;
  const actionable = validContract(contract) && isFreshSpot(bundle);
  const lock = current?.coreLock ?? null;
  const activeLock = lock && !lock.settledAt;
  const quote = contract ? (side === "YES" ? contract.yesAsk : contract.noAsk) : NaN;
  const quoteValid = validQuote(quote);
  const sizeNumber = Number(size);
  const sizeValid = Number.isSafeInteger(sizeNumber) && sizeNumber > 0;
  const paperEnabled = actionable && quoteValid && sizeValid && !current?.hardStop.active && !lock?.missed;
  const displayErrors = errors.filter(Boolean);
  const updateSnapshotFromLocal = () => {
    if (!bundle) return;
    setBundle({ ...bundle, snapshot: buildSnapshot(bundle.contract, bundle.spot, bundle.bars) });
    syncLocalRows();
  };
  const withErrorRefresh = (message: string) => {
    setErrors([message]);
    void refresh(false);
  };

  const onLock = () => {
    if (!contract || !actionable || activeLock || !current?.liveCall || missed) return;
    if (contract.openTime && Date.parse(contract.openTime) <= Date.now()) return;
    try {
      const saved = lockFromLive(contract, bundle?.spot ?? null, bundle?.bars ?? []);
      if (!saved) throw new Error("The live signal is not complete enough to lock.");
      updateSnapshotFromLocal();
    } catch (error) {
      withErrorRefresh(error instanceof Error ? error.message : String(error));
    }
  };

  const onPaper = () => {
    setFormError("");
    if (!contract || !actionable || !quoteValid || !sizeValid || current?.hardStop.active) {
      setFormError("Paper entry needs a live contract, fresh spot, valid ask and a positive whole-number size.");
      return;
    }
    try {
      placePaper(contract, side, sizeNumber);
      updateSnapshotFromLocal();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      void refresh(false);
    }
  };

  const onReference = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const n = Number(customRef);
    if (!Number.isFinite(n) || n <= 0) {
      setReferenceError("Enter a reference price greater than zero.");
      return;
    }
    try {
      setCustomReference(n);
      setReferenceError("");
      updateSnapshotFromLocal();
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : String(error));
      void refresh(false);
    }
  };

  const expiries = useMemo(() => {
    const grouped = new Map<string, { ticker: string; market: "15m" | "5m"; strike: number | null; closeTime: string; pending: number }>();
    [...journal.map((row) => ({ ...row, source: "lock" as const })), ...trades.map((row) => ({ ...row, source: "trade" as const }))].forEach((row) => {
      const derivedClose = row.source === "lock"
        ? row.closeTime
        : journal.find((entry) => entry.windowId === row.windowId)?.closeTime ?? row.windowId.split("::").slice(1).join("::");
      const existing = grouped.get(row.windowId) ?? { ticker: row.ticker, market: row.market, strike: row.strike, closeTime: derivedClose, pending: 0 };
      if (!row.settledAt && !(row.source === "lock" && (row.missed || row.awaitingStrike))) existing.pending += 1;
      grouped.set(row.windowId, existing);
    });
    return [...grouped.entries()]
      .filter(([, item]) => item.pending > 0 && Number.isFinite(new Date(item.closeTime).getTime()) && new Date(item.closeTime).getTime() < Date.now())
      .map(([windowId, item]) => ({ windowId, ...item }))
      .sort((a, b) => new Date(b.closeTime).getTime() - new Date(a.closeTime).getTime());
  }, [journal, trades, now]);

  const onSettle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSettleError("");
    const selected = expiries.find((item) => item.windowId === settlementWindowId);
    const px = Number(finalPrice);
    if (!selected || new Date(selected.closeTime).getTime() >= Date.now()) {
      setSettleError("Choose an expired historical window. Early settlement is not available.");
      return;
    }
    if (!Number.isFinite(px) || px <= 0) {
      setSettleError("Enter a final price greater than zero.");
      return;
    }
    try {
      settleWindow({
        ticker: selected.ticker,
        market: selected.market,
        strike: selected.strike,
        closeTime: selected.closeTime,
        series: selected.market === "15m" ? "BTC15" : "BTC5",
        yesAsk: 0,
        noAsk: 0,
      }, px);
      setFinalPrice("");
      setSettleError("");
      syncLocalRows();
      updateSnapshotFromLocal();
    } catch (error) {
      setSettleError(error instanceof Error ? error.message : String(error));
      void refresh(false);
    }
  };

  const missed = !!lock?.missed;
  const feedFresh = !!bundle && !displayErrors.length && isFreshSpot(bundle);
  const feedLabel = loading ? "CONNECTING" : feedFresh ? "LIVE FEED" : "STALE";
  const displayCall = missed ? "MISSED" : lock?.awaitingStrike ? "no call" : current?.liveCall ?? null;
  const upcoming = bundle?.upcoming ?? null;
  const upcomingLock = upcoming
    ? journal.find((row) => row.windowId === windowId(upcoming.ticker, upcoming.closeTime)) ?? null
    : null;
  const tick = lock ? tenMinuteTick(lock.openTime) : null;
  const closeMs = lock ? Date.parse(lock.closeTime) : NaN;
  const canRevise = !!lock && !missed && !lock.awaitingStrike && lock.lockedCall != null && !lock.revisionRefusal && tick != null && now >= tick.start && now < tick.end && now < closeMs && isFreshSpot(bundle);
  const upcomingCall = !upcomingLock || upcomingLock.awaitingStrike
    ? "no call"
    : upcomingLock.missed
      ? "MISSED"
      : upcomingLock.revisedCall ?? upcomingLock.lockedCall ?? "no call";
  const upcomingStrike = upcoming?.strike != null && upcoming.strike > 0 ? money(upcoming.strike) : "—";
  const effectiveLocked = lock?.revisedCall ?? lock?.lockedCall ?? null;
  const onRevise = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setReviseError("");
    if (!lock) return;
    try {
      reviseLockedCall(lock.windowId, reviseTo, reviseReason, Date.now(), bundle?.spot ?? null);
      setReviseReason("");
      updateSnapshotFromLocal();
    } catch (error) {
      setReviseError(error instanceof Error ? error.message : String(error));
      updateSnapshotFromLocal();
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div><div className="brand-name">Samuel's Command Center</div><div className="brand-caption">Money desk</div></div>
        </div>
        <div className="topbar-right">
          <div className="feed-status" data-testid="feed-status"><i className={`status-dot ${feedFresh ? "" : "offline"}`} /> <span>{feedLabel}</span><span>· 15M</span></div>
          <button className="refresh-button" onClick={() => void refresh(true)} disabled={refreshing}>
            <span className={`refresh-icon ${refreshing ? "refreshing" : ""}`}>↻</span>{refreshing ? "Updating" : "Refresh"}
          </button>
        </div>
      </header>
      <nav className="section-nav" aria-label="Command center">
        <button className={section === "hourly" ? "active" : ""} onClick={() => setSection("hourly")}>Hourly picks</button>
        <button className={section === "btc" ? "active" : ""} onClick={() => setSection("btc")}>BTC 15</button>
        <button className={section === "arb" ? "active" : ""} onClick={() => setSection("arb")}>Sports arb</button>
        <button className={section === "assistant" ? "active" : ""} onClick={() => setSection("assistant")}>Assistant</button>
        <button className={section === "orders" ? "active" : ""} onClick={() => setSection("orders")}>Place bet</button>
        <button className={section === "log" ? "active" : ""} onClick={() => setSection("log")}>Trade Log</button>
      </nav>
      {section === "hourly" && <HourlySection onPrepare={prepare} />}
      {section === "arb" && <ArbSection />}
      {section === "assistant" && <AssistantSection />}
      {section === "orders" && <OrdersSection draft={draft} />}
      {section === "log" && <TradeLogSection />}

      {section === "btc" && <main className="main">
        <div className="page-heading">
          <div><div className="eyebrow">Market session / bitcoin</div><h1>Short-window desk</h1><p>Make the call. Lock the record. Practice without capital at risk.</p></div>
          <div className="time-stamp">AUTO POLL · 8 SEC<br />{bundle ? `LAST CHECK ${dateTime(bundle.polledAt)}` : "WAITING FOR FIRST CHECK"}</div>
        </div>

        <nav className="tabs" aria-label="Desk sections">
          <button className={`tab ${tab === "desk" ? "active" : ""}`} onClick={() => setTab("desk")}>Desk</button>
          <button className={`tab ${tab === "journal" ? "active" : ""}`} onClick={() => setTab("journal")}>Journal <span className="tab-count">{journal.length}</span></button>
          <button className={`tab ${tab === "trades" ? "active" : ""}`} onClick={() => setTab("trades")}>Paper trade log <span className="tab-count">{trades.length}</span></button>
        </nav>

        {displayErrors.length > 0 && (
          <div className="error-banner" role="alert">
            <div><strong>Feed check needs attention</strong>{displayErrors.join(" · ")}<br />Any missing market or spot data is intentionally left blank.</div>
            <button onClick={() => void refresh(true)}>Try again</button>
          </div>
        )}

        {tab === "desk" && (
          loading ? <div className="grid reveal"><div className="column"><div className="panel"><div className="panel-head"><div><div className="panel-title">Active 15-minute window</div><div className="panel-kicker">Waiting for live market data</div></div></div><div className="placeholder"><div className="placeholder-mark">···</div>Connecting to the market feeds. No sample values are shown.</div></div><div className="panel"><div className="placeholder">Signal and lock details appear when live inputs arrive.</div></div></div><div className="column"><div className="panel"><div className="placeholder">Paper position entry is unavailable until a valid live contract and fresh spot are confirmed.</div></div></div></div> :
          <div className="grid reveal">
            <div className="column">
              <section className="panel">
                <div className="panel-head"><div><div className="panel-title">Active 15-minute window</div><div className="panel-kicker">{feedFresh ? "Contract terms · live market" : "Contract terms · STALE"}</div></div><span className="window-badge">BTC / 15M</span></div>
                {contract ? <>
                  <div className="contract-body">
                    <div className="contract-name-row"><div><div className="contract-name">Bitcoin above or below strike</div><div className="ticker">{contract.ticker}</div><div className="ticker" data-testid="window-name">{windowNameByEnd(contract.closeTime)} · named by its end</div></div><div className="subtle-label">{validContract(contract) ? `CLOSES IN ${minutesText(contract.closeTime)}` : "WINDOW EXPIRED"}</div></div>
                    <div className="contract-metrics">
                      <div className="metric"><div className="metric-label">{feedFresh ? "Live spot" : "Spot · STALE"}</div><div className="metric-value large">{isFreshSpot(bundle) ? money(bundle?.spot?.price) : "—"}</div></div>
                      <div className="metric"><div className="metric-label">Strike</div><div className="metric-value">{contract.strike != null && contract.strike > 0 ? money(contract.strike) : "—"}</div></div>
                      <div className="metric"><div className="metric-label">Contract close</div><div className="metric-value">{dateTime(contract.closeTime)}</div></div>
                    </div>
                    <div className="spot-row"><span className={`status-dot ${feedFresh ? "" : "offline"}`} /><strong>{isFreshSpot(bundle) ? money(bundle?.spot?.price) : "No spot tick"}</strong><span className="source-chip">{feedFresh ? (bundle?.spot?.source ?? "no source") : "STALE"}</span><span>{feedFresh && bundle?.spot ? `updated ${dateTime(bundle.spot.ts)}` : "STALE"}</span></div>
                  </div>
                </> : <div className="placeholder"><div className="placeholder-mark">—</div>No active 15-minute contract was returned by the live feed.<br />The desk will keep checking; no market terms are inferred.<br />Kraken spot: {isFreshSpot(bundle) ? money(bundle?.spot?.price) : "Unavailable"}</div>}
              </section>
              {upcoming && <section className="panel" data-testid="upcoming-window">
                <div className="panel-head"><div><div className="panel-title">Next 15-minute window</div><div className="panel-kicker">Official strike only</div></div><span className="window-badge">NEXT</span></div>
                <div className="contract-body">
                  <div className="contract-name-row"><div><div className="contract-name">Upcoming contract</div><div className="ticker">{upcoming.ticker}</div></div><div className="subtle-label">{upcoming.openTime ? `OPENS ${dateTime(upcoming.openTime)}` : "OPEN TIME UNKNOWN"}</div></div>
                  <div className="contract-metrics">
                    <div className="metric"><div className="metric-label">Official strike</div><div className="metric-value" data-testid="upcoming-strike">{upcomingStrike}</div></div>
                    <div className="metric"><div className="metric-label">Call</div><div className="metric-value" data-testid="upcoming-call">{upcomingCall}</div></div>
                  </div>
                  <div className="data-note">{upcomingCall === "no call" ? "No official floor_strike yet. No call and no strike." : upcomingCall === "MISSED" ? "The strike posted while this desk was not able to lock. No call was back-filled." : "Locked on the poll that first saw the official strike."}</div>
                </div>
              </section>}

              <section className="panel">
                <div className="panel-head"><div><div className="panel-title">{feedFresh ? "Live read" : "Read · STALE"}</div><div className="panel-kicker">Heuristic signal · not a forecast</div></div>{current && !missed && <span className={`action-pill ${current.action.toLowerCase().replace("_", "-")}`}>{current.action.replace("_", " ")}</span>}</div>
                {current && (missed || current.liveCall || current.actionWhy) ? <div className="signal-layout">
                  <div className={`call-box ${(displayCall ?? "").toLowerCase().replace(/\s+/g, "-")}`}>
                    <div className="subtle-label">Directional call</div>
                    <div><div className={`call-direction ${(displayCall ?? "none").toLowerCase().replace(/\s+/g, "-")}`} data-testid="directional-call">{displayCall ?? "—"}</div><div className="confidence-line">{missed ? "No call was locked" : current.liveCall ? `${current.confidence}% confidence` : "No valid call"}</div></div>
                  </div>
                  <div className="signal-detail"><div className="subtle-label">Why this read</div><p className="reason">{missed ? "No call was locked before this window opened." : current.actionWhy || "Waiting for enough valid data to form a read."}</p><div className="factor-list">{missed ? <span className="factor">MISSED</span> : current.factors.length ? current.factors.map((factor, i) => <span className="factor" key={`${factor}-${i}`}>{factor}</span>) : <span className="factor">No supporting factors available</span>}</div></div>
                </div> : <div className="placeholder">Signal unavailable until live inputs support a valid read.</div>}
                {current?.hardStop.active && <div style={{ padding: "0 20px 15px" }}><div className="hard-stop"><strong>Hard stop active</strong>{current.hardStop.reason}{current.hardStop.until ? ` · until ${dateTime(current.hardStop.until)}` : ""}</div></div>}
                {!actionable && <div className="data-note" style={{ padding: "0 20px 14px" }}>Live read is unavailable or out of date. New calls and paper entries are disabled.</div>}
                {missed ? <div className="lock-strip"><div className="lock-copy"><strong>MISSED</strong>This window was already open. The desk does not back-fill a call.</div><button className="button-secondary" type="button" disabled>Missed</button></div> : <div className={`lock-strip ${activeLock ? "locked" : ""}`}><div className="lock-copy"><strong>{activeLock ? `Locked ${effectiveLocked} · ${lock.confidence}% · ${dateTime(lock.lockedAt)}` : "Immutable core lock"}</strong>{lock?.revision ? ` Halfway change: ${lock.revision.from} to ${lock.revision.to}. ${lock.revision.reason}` : activeLock ? "This window's original directional call cannot be edited." : "Record the live call once for this contract window."}</div><button className={activeLock ? "button-secondary" : "button-primary"} onClick={onLock} disabled={!actionable || !current?.liveCall || !!lock}>{lock ? "Locked" : "Lock this call"}</button></div>}
                {canRevise && <form className="settle-panel" data-testid="revise-form" onSubmit={onRevise}><div className="settle-row"><label><span className="size-label">Revised call</span><select aria-label="Revised call" className="input settle-select" value={reviseTo} onChange={(e) => setReviseTo(e.target.value as Direction)}><option>UP</option><option>DOWN</option><option>AT STRIKE</option></select></label><label><span className="size-label">Reason</span><input aria-label="Change reason" className="input settle-select" value={reviseReason} onChange={(e) => setReviseReason(e.target.value)} placeholder="Why this one change" /></label><button className="button-secondary" type="submit">Save change</button></div>{lock?.revision && <div className="settle-help" data-testid="revision-note">Changed {lock.revision.from} to {lock.revision.to}: {lock.revision.reason}</div>}</form>}
                {lock?.revisionRefusal && <div className="form-error" data-testid="revision-refusal" role="alert">Second change refused. {lock.revisionRefusal.attempted} was not applied.</div>}
                {reviseError && <div className="form-error" role="alert">{reviseError}</div>}
              </section>

              <section className="panel">
                <div className="panel-head"><div><div className="panel-title">Custom reference</div><div className="panel-kicker">Personal comparison level · browser saved</div></div></div>
                <div className="reference-row"><div className="reference-copy"><div className="subtle-label">Your reference</div><div className="reference-value">{current?.customRef ? money(current.customRef) : "Not set"}</div></div><form className="inline-form" onSubmit={onReference}><input aria-label="Custom reference price" className="input" type="number" min="0.000001" step="any" placeholder="Enter price" value={customRef} onChange={(e) => setCustomRef(e.target.value)} /><button className="button-secondary" type="submit">Save level</button><button className="button-secondary" type="button" onClick={() => { try { setCustomReference(null); setCustomRef(""); setReferenceError(""); updateSnapshotFromLocal(); } catch (error) { setReferenceError(error instanceof Error ? error.message : String(error)); void refresh(false); } }}>Clear</button></form></div>
                {referenceError && <div className="form-error" role="alert">{referenceError}</div>}
                {current?.customRef != null && current.distanceToCustom != null && <div className="lock-strip"><div className="lock-copy"><strong>Spot vs reference</strong>{current.leanVsCustom ?? "—"} · {money(Math.abs(current.distanceToCustom))} {current.distanceToCustom === 0 ? "at the reference" : current.distanceToCustom > 0 ? "above" : "below"}</div></div>}
              </section>
            </div>

            <div className="column">
              {current?.hardStop.active && <div className="hard-stop"><strong>Trading hard-stop</strong>{current.hardStop.reason}</div>}
              <section className="panel">
                <div className="panel-head"><div><div className="panel-title">Paper position</div><div className="panel-kicker">Simulated only · not sent to exchange</div></div><span className="window-badge">PAPER</span></div>
                <div className="paper-body">
                  <div className="paper-side-switch" role="group" aria-label="Choose paper trade side">
                    <button className={`side-option ${side === "YES" ? "active yes" : ""}`} onClick={() => setSide("YES")}>YES</button>
                    <button className={`side-option ${side === "NO" ? "active no" : ""}`} onClick={() => setSide("NO")}>NO</button>
                  </div>
                  <div className="paper-entry">
                    <div className={`quote ${quoteValid ? "" : "invalid"}`}><div className="quote-label">{side} ask · {feedFresh ? "live quote" : "STALE"}</div><div className="quote-value">{quoteValid ? quote.toFixed(3) : "Unavailable"}</div></div>
                    <label><span className="size-label">Contracts</span><input className="input paper-size" type="number" min="1" step="1" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value)} /></label>
                  </div>
                  <p className="paper-warning">Paper only. This creates a browser-local practice record and does not place an order or move money.</p>
                  <button className="button-primary paper-button" onClick={onPaper} disabled={!paperEnabled}>Record paper {side}</button>
                  {!actionable && <p className="paper-warning">{contract && !validContract(contract) ? "The current contract has expired." : !isFreshSpot(bundle) ? "A fresh spot tick is required." : "Waiting for an active contract."}</p>}
                  {actionable && !quoteValid && <p className="paper-warning">No valid {side} ask is available from the live feed.</p>}
                  {formError && <p className="form-error" role="alert" style={{ margin: "10px 0 0" }}>{formError}</p>}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head"><div><div className="panel-title">Evidence ledger</div><div className="panel-kicker">Settled directional calls</div></div></div>
                <div className="evidence"><div className="evidence-top"><div><div className="subtle-label">Settled / target</div><div className="evidence-number">{current?.evidence.settled ?? 0}<small> / {current?.evidence.target ?? 20}</small></div></div><div style={{ textAlign: "right" }}><div className="subtle-label">Win rate</div><div className="evidence-number">{current?.evidence.winRate ?? "—"}</div></div></div><div className="evidence-progress"><span style={{ width: `${Math.min(100, ((current?.evidence.settled ?? 0) / Math.max(1, current?.evidence.target ?? 20)) * 100)}%` }} /></div><div className="evidence-meta"><span>{current?.evidence.wins ?? 0} correct calls</span><span>{Math.max(0, (current?.evidence.target ?? 20) - (current?.evidence.settled ?? 0))} to sample target</span></div></div>
              </section>
              <section className="panel">
                <div className="panel-head"><div><div className="panel-title">Manual settlement</div><div className="panel-kicker">Expired windows only · user entered</div></div></div>
                <form className="settle-panel" onSubmit={onSettle}>
                  <div className="settle-row">
                    <label><span className="size-label">Historical window</span><select className="input settle-select" value={settlementWindowId} onChange={(e) => setSettlementWindowId(e.target.value)}><option value="">Select expired window</option>{expiries.map((item) => <option key={item.windowId} value={item.windowId}>{item.ticker} · {dateTime(item.closeTime)} · {item.pending} open record{item.pending === 1 ? "" : "s"}</option>)}</select></label>
                    <label><span className="size-label">Final price</span><input className="input settle-select" type="number" min="0.000001" step="any" placeholder="Enter price" value={finalPrice} onChange={(e) => setFinalPrice(e.target.value)} /></label>
                    <button className="button-warn" type="submit" disabled={!expiries.length}>Settle manually</button>
                  </div>
                  <div className="settle-help">Enter a final price for this practice record. This is user-entered, not verified. Kalshi uses a CF Benchmarks index average, not Kraken spot. Never settled automatically.</div>
                  {settleError && <div className="form-error" role="alert" style={{ margin: "8px 0 0" }}>{settleError}</div>}
                </form>
              </section>
              <div className="data-note">Research heuristic only; not financial advice. Feed availability and quotes can be incomplete or stale. Journal and paper records are stored only in this browser.</div>
            </div>
          </div>
        )}

        {tab === "journal" && <section className="panel table-panel reveal">
          <div className="history-heading"><div><div className="panel-title">Directional journal</div><div className="panel-kicker">Immutable calls · browser-local records</div></div><button className="button-secondary" onClick={() => { syncLocalRows(); void refresh(true); }}>Refresh records</button></div>
          {journal.length === 0 ? <div className="placeholder"><div className="placeholder-mark">—</div>No directional calls have been locked yet.<br />A call recorded on the desk will appear here and cannot be rewritten.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Window</th><th>Locked at</th><th>Call</th><th>Confidence</th><th>Start spot</th><th>Strike</th><th>Outcome</th><th>Result</th></tr></thead><tbody>{journal.map((row) => <tr key={row.windowId}><td className="table-primary">{row.ticker}<br /><span style={{ color: "#8a958e" }}>{dateTime(row.closeTime)}</span></td><td>{dateTime(row.lockedAt)}</td><td className={row.missed ? "" : row.lockedCall === "UP" || row.lockedCall === "AT STRIKE" ? "result-good" : "result-bad"}>{row.awaitingStrike ? "no call" : row.missed ? "MISSED" : row.revisedCall ? `${row.lockedCall} → ${row.revisedCall}` : row.lockedCall}{row.revision ? <div>Reason: {row.revision.reason}</div> : null}{row.revisionRefusal ? <div>Second change refused</div> : null}</td><td>{row.confidence}%</td><td>{row.awaitingStrike ? "—" : money(row.startPx)}</td><td>{row.awaitingStrike || row.strike == null ? "—" : money(row.strike)}</td><td>{row.outcome ?? (row.settledAt ? "—" : "Pending")}</td><td className={row.hit === true ? "result-good" : row.hit === false ? "result-bad" : ""}>{row.hit == null ? "—" : row.hit ? "Correct" : "Miss"}</td></tr>)}</tbody></table></div>}
          <div className="data-note" style={{ padding: "14px 20px" }}>Saved to local browser storage only. Clearing browser data removes this journal.</div>
        </section>}

        {tab === "trades" && <div className="column reveal">
          <section className="panel table-panel">
            <div className="history-heading"><div><div className="panel-title">Paper trade log</div><div className="panel-kicker">Simulated YES / NO positions · no exchange execution</div></div><button className="button-secondary" onClick={() => { syncLocalRows(); void refresh(true); }}>Refresh records</button></div>
            {trades.length === 0 ? <div className="placeholder"><div className="placeholder-mark">—</div>No paper positions recorded.<br />Paper stays in this browser. A live order is only on Place bet, after you confirm that exact trade and the approval password checks.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Window</th><th>Opened</th><th>Side</th><th>Size</th><th>Entry ask</th><th>Strike</th><th>Status</th><th>End price</th><th>Paper P&amp;L</th></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td className="table-primary">{trade.ticker}<br /><span style={{ color: "#8a958e" }}>{trade.market}</span></td><td>{dateTime(trade.openedAt)}</td><td className={trade.side === "YES" ? "result-good" : "result-bad"}>{trade.side}</td><td>{trade.size}</td><td>{trade.entry.toFixed(3)}</td><td>{money(trade.strike)}</td><td>{trade.settledAt ? "Settled" : "Open"}</td><td>{trade.endPx == null ? "—" : money(trade.endPx)}</td><td className={trade.pnl == null ? "" : trade.pnl >= 0 ? "result-good" : "result-bad"}>{trade.pnl == null ? "—" : `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`}</td></tr>)}</tbody></table></div>}
            <div className="data-note" style={{ padding: "14px 20px" }}>Paper records and settlements exist only in this browser. No funds, orders, or exchange accounts are involved.</div>
          </section>
          <section className="panel">
            <div className="panel-head"><div><div className="panel-title">Settle expired positions</div><div className="panel-kicker">Manual input · never inferred from live spot</div></div></div>
            <form className="settle-panel" onSubmit={onSettle}>
              <div className="settle-row"><label><span className="size-label">Expired window</span><select className="input settle-select" value={settlementWindowId} onChange={(e) => setSettlementWindowId(e.target.value)}><option value="">Select historical window</option>{expiries.map((item) => <option key={item.windowId} value={item.windowId}>{item.ticker} · {dateTime(item.closeTime)} · {item.pending} open record{item.pending === 1 ? "" : "s"}</option>)}</select></label><label><span className="size-label">User-entered final price</span><input className="input settle-select" type="number" min="0.000001" step="any" placeholder="Enter price" value={finalPrice} onChange={(e) => setFinalPrice(e.target.value)} /></label><button className="button-warn" type="submit" disabled={!expiries.length}>Settle manually</button></div>
              <div className="settle-help">This input is not an official or verified Kraken settlement value. Only expired historical windows may be settled; early settlement is blocked.</div>{settleError && <div className="form-error" role="alert" style={{ margin: "8px 0 0" }}>{settleError}</div>}
            </form>
          </section>
        </div>}
      </main>}
    </div>
  );
}

export default App;


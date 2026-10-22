/**
 * BTC15 call lifecycle.
 *
 * Every window gets a call. The initial call is locked before open and is
 * immutable. One revision may be recorded at the halfway checkpoint. After
 * that the call is final. Settlement appends an outcome; it does not edit
 * either decision.
 *
 * The official KXBTC15M strike is not published before the window opens.
 * See CALL_LIFECYCLE.md. The pre-start call projects the window from
 * indicators and leaves strike null until Kalshi prints floor_strike.
 * The halfway call, once a strike exists, is last vs that strike.
 * LIVE / STALE / NO DATA is attached to the decision and does not block it.
 */

import type { Agreement, DataQuality, Direction } from "./types";
import {
  closedBars,
  readIndicators,
  type Bar1m,
  type IndicatorReading,
  type IndicatorVote,
} from "./engine";
import {
  AT_STRIKE_EPSILON_USD,
  BAR_LIVE_MS,
  CHECKPOINT_TOLERANCE_MS,
  MIN_CLOSED_BARS,
  QUOTE_LIVE_MS,
  WINDOW_MS,
  compareToStrike,
  halfwayAt,
  isHalfwayCheckpoint,
} from "./strike-call";
import {
  CallLedger,
  foldWindow,
  windowCallId,
  type CallBasis,
  type CallDecision,
  type CallRevision,
  type EvidenceCitation,
  type EvidenceRole,
  type LedgerEvent,
  type PriceSource,
  type QualityParts,
  type StrikeSource,
  type WindowCallState,
} from "./call-ledger";

/** Lock the single next window only inside this lead before its open. */
export const LOCK_LEAD_MS = 120_000;
/** Healthy loop cadence. Short enough to land inside the 60s halfway checkpoint. */
export const LOOP_TICK_MS = 8_000;
/** Error backoff never grows past this, so a 60s checkpoint can still be hit. */
export const LOOP_BACKOFF_CAP_MS = 20_000;
/**
 * A window with no pre-start lock is marked missed only while it is open,
 * or this long after it closes. Older history is left alone.
 */
export const MISSED_LOOKBACK_MS = 20 * 60 * 1000;

const MISSED_REASON =
  "The process had no call on file when the window opened, so no call was invented.";

export interface KrakenQuote {
  price: number;
  ts: number;
  source: "kraken";
}

export interface Btc15CallInput {
  ticker: string;
  openTime: string;
  closeTime: string;
  /** Kalshi floor_strike. Null while the market still says Target price TBD. */
  floorStrike: number | null;
  /** Kalshi expiration_value. Null until the window is settled. Not a substitute strike. */
  expirationValue?: number | null;
  spot: KrakenQuote | null;
  bars: Bar1m[];
  now: number;
}

export class CallLifecycleError extends Error {
  readonly code:
    | "TOO_LATE_TO_LOCK"
    | "TOO_EARLY_TO_REVISE"
    | "CHECKPOINT_PASSED"
    | "ALREADY_REVISED"
    | "UNKNOWN_WINDOW"
    | "ALREADY_SETTLED"
    | "MISSING_SETTLEMENT_INPUT"
    | "BAD_WINDOW";

  constructor(code: CallLifecycleError["code"], message: string) {
    super(message);
    this.name = "CallLifecycleError";
    this.code = code;
  }
}

const UNPUBLISHED_ANCHOR =
  "KXBTC15M floor_strike is the 60-second CF Benchmarks BRTI average of the minute before open. Kalshi lists the window with Target price TBD and no floor_strike until that average is printed, which is at or just after open. This call does not invent that number.";

export function worstQuality(parts: DataQuality[]): DataQuality {
  if (parts.includes("NO DATA")) return "NO DATA";
  if (parts.includes("STALE")) return "STALE";
  return "LIVE";
}

export function verifiedStrike(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function verifiedQuote(
  spot: KrakenQuote | null,
  bars: Bar1m[],
  now: number
): { price: number | null; ts: number | null; source: PriceSource } {
  if (
    spot &&
    spot.source === "kraken" &&
    Number.isFinite(spot.price) &&
    spot.price > 0 &&
    Number.isFinite(spot.ts)
  ) {
    return { price: spot.price, ts: spot.ts, source: "kraken_ticker" };
  }
  const closed = closedBars(bars, now);
  const last = closed.length ? closed[closed.length - 1] : null;
  if (last && Number.isFinite(last.close) && last.close > 0) {
    return {
      price: last.close,
      ts: last.t + 60_000,
      source: "kraken_1m_close",
    };
  }
  return { price: null, ts: null, source: "none" };
}

export function assessQuality(
  input: Btc15CallInput,
  quoteTs: number | null,
  price: number | null,
  strike: number | null
): QualityParts {
  let quote: DataQuality = "NO DATA";
  if (price != null && quoteTs != null) {
    const age = input.now - quoteTs;
    quote = age >= 0 && age <= QUOTE_LIVE_MS ? "LIVE" : "STALE";
  }

  const strikeQ: DataQuality = strike != null ? "LIVE" : "NO DATA";

  const openMs = Date.parse(input.openTime);
  const closeMs = Date.parse(input.closeTime);
  const clock: DataQuality =
    Number.isFinite(openMs) &&
    Number.isFinite(closeMs) &&
    Number.isFinite(input.now) &&
    Math.abs(closeMs - openMs - WINDOW_MS) <= 1_500
      ? "LIVE"
      : "NO DATA";

  const closed = closedBars(input.bars, input.now);
  let bars: DataQuality = "NO DATA";
  if (closed.length >= MIN_CLOSED_BARS) {
    const end = closed[closed.length - 1].t + 60_000;
    const age = input.now - end;
    bars = age >= 0 && age <= BAR_LIVE_MS ? "LIVE" : "STALE";
  }

  return { quote, strike: strikeQ, clock, bars };
}

function roleFor(call: Direction, vote: IndicatorVote): EvidenceRole {
  if (vote === "NEUTRAL") return call === "AT STRIKE" ? "SUPPORTS" : "NEUTRAL";
  if (call === "AT STRIKE") return "CONFLICTS";
  return vote === call ? "SUPPORTS" : "CONFLICTS";
}

export function agreementFrom(
  evidence: { role: EvidenceRole }[]
): Agreement {
  const supports = evidence.filter((e) => e.role === "SUPPORTS").length;
  const conflicts = evidence.filter((e) => e.role === "CONFLICTS").length;
  if (supports >= 2 && conflicts === 0) return "strong";
  return "weak";
}

function projectCall(readings: IndicatorReading[]): Direction {
  let up = 0;
  let down = 0;
  for (const reading of readings) {
    if (reading.vote === "UP") up += 1;
    else if (reading.vote === "DOWN") down += 1;
  }
  if (up > down) return "UP";
  if (down > up) return "DOWN";
  return "AT STRIKE";
}

function cite(
  call: Direction,
  readings: IndicatorReading[],
  price: number | null,
  strike: number | null
): EvidenceCitation[] {
  const evidence: EvidenceCitation[] = readings.map((reading) => ({
    indicator: reading.indicator,
    role: roleFor(call, reading.vote),
    raw: reading.raw,
  }));
  if (price != null && strike != null) {
    const spotCall = compareToStrike(price, strike);
    evidence.push({
      indicator: "SPOT_VS_STRIKE",
      role: roleFor(call, spotCall === "AT STRIKE" ? "NEUTRAL" : spotCall),
      raw: {
        price,
        strike,
        epsilon: AT_STRIKE_EPSILON_USD,
      },
    });
  }
  return evidence;
}

function voteCounts(readings: IndicatorReading[]): {
  up: number;
  down: number;
  neutral: number;
} {
  return {
    up: readings.filter((r) => r.vote === "UP").length,
    down: readings.filter((r) => r.vote === "DOWN").length,
    neutral: readings.filter((r) => r.vote === "NEUTRAL").length,
  };
}

function buildDecision(
  input: Btc15CallInput,
  basis: CallBasis
): CallDecision {
  const strike = verifiedStrike(input.floorStrike);
  const quote = verifiedQuote(input.spot, input.bars, input.now);
  const parts = assessQuality(input, quote.ts, quote.price, strike);
  const quality = worstQuality([parts.quote, parts.strike, parts.clock, parts.bars]);
  const readings = readIndicators(quote.price, input.bars, input.now);
  const closed = closedBars(input.bars, input.now);
  const lastEnd = closed.length ? closed[closed.length - 1].t + 60_000 : null;

  let call: Direction;
  let why: string;
  if (basis === "last_vs_strike" && quote.price != null && strike != null) {
    call = compareToStrike(quote.price, strike);
    why =
      `Halfway check uses Kraken ${quote.source} ${quote.price} ` +
      `vs published floor_strike ${strike} (epsilon ${AT_STRIKE_EPSILON_USD}) → ${call}. ` +
      `Indicators are evidence only. Quality ${quality}.`;
  } else {
    call = projectCall(readings);
    const counts = voteCounts(readings);
    if (basis === "last_vs_strike") {
      why =
        `Halfway checkpoint has no verified price and published strike together, ` +
        `so the revision uses the trend projection instead of an invented number. ` +
        `Votes UP ${counts.up}, DOWN ${counts.down}, NEUTRAL ${counts.neutral} → ${call}. ` +
        `Quality ${quality}.`;
    } else if (strike == null) {
      why =
        `Pre-start projection. ${UNPUBLISHED_ANCHOR} ` +
        `Votes UP ${counts.up}, DOWN ${counts.down}, NEUTRAL ${counts.neutral} → ${call}, ` +
        `meaning the close average is projected to finish ${call === "AT STRIKE" ? "within epsilon of" : call === "UP" ? "above" : "below"} the still-unpublished open average. ` +
        `Quality ${quality}.`;
    } else {
      why =
        `Pre-start projection against published floor_strike ${strike}. ` +
        `The window has not started, so the call is the trend rather than spot versus strike. ` +
        `Votes UP ${counts.up}, DOWN ${counts.down}, NEUTRAL ${counts.neutral} → ${call}. ` +
        `Quality ${quality}.`;
    }
  }

  const evidence = cite(call, readings, quote.price, strike);
  return {
    call,
    at: input.now,
    basis: basis === "last_vs_strike" && (quote.price == null || strike == null)
      ? "trend_projection"
      : basis,
    quality,
    qualityParts: parts,
    agreement: agreementFrom(evidence),
    price: quote.price,
    priceTs: quote.ts,
    priceSource: quote.source,
    strike,
    strikeSource: strike != null ? "kalshi_floor_strike" : "unpublished",
    anchorNote: strike != null
      ? "Strike is the published Kalshi floor_strike."
      : UNPUBLISHED_ANCHOR,
    openTime: input.openTime,
    closeTime: input.closeTime,
    barCount: closed.length,
    lastClosedBarEndTs: lastEnd,
    evidence,
    why,
  };
}

function requireWindow(input: Btc15CallInput): {
  openMs: number;
  id: string;
  input: Btc15CallInput;
} {
  const openMs = Date.parse(input.openTime);
  const closeMs = Date.parse(input.closeTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) {
    throw new CallLifecycleError("BAD_WINDOW", "Window open and close must be timestamps");
  }
  if (!input.ticker) {
    throw new CallLifecycleError("BAD_WINDOW", "Window ticker is required");
  }
  const openTime = new Date(openMs).toISOString();
  const closeTime = new Date(closeMs).toISOString();
  return {
    openMs,
    id: windowCallId(input.ticker, openTime, closeTime),
    input: { ...input, openTime, closeTime },
  };
}

function stateFor(
  ledger: CallLedger,
  id: string,
  ticker: string
): WindowCallState | null {
  return foldWindow(ledger.all(), id, ticker);
}

/**
 * Lock the initial call. Must run before openTime.
 * A second call returns the original decision unchanged.
 */
export function lockInitialCall(
  ledger: CallLedger,
  input: Btc15CallInput
): WindowCallState {
  const window = requireWindow(input);
  const { openMs, id } = window;
  input = window.input;
  const existing = stateFor(ledger, id, input.ticker);
  if (existing) return existing;
  if (input.now >= openMs) {
    throw new CallLifecycleError(
      "TOO_LATE_TO_LOCK",
      "Initial call must be locked before the window starts"
    );
  }
  const decision = buildDecision(input, "trend_projection");
  ledger.append({ type: "initial", windowId: id, decision });
  return stateFor(ledger, id, input.ticker)!;
}

/**
 * Record the single halfway decision. Rejected outside the checkpoint
 * and rejected again after one revision exists.
 */
export function reviseAtHalfway(
  ledger: CallLedger,
  input: Btc15CallInput
): WindowCallState {
  const window = requireWindow(input);
  const { openMs, id } = window;
  input = window.input;
  const existing = stateFor(ledger, id, input.ticker);
  if (!existing) {
    throw new CallLifecycleError(
      "UNKNOWN_WINDOW",
      "Halfway revision requires a pre-start lock"
    );
  }
  if (existing.revision) {
    throw new CallLifecycleError(
      "ALREADY_REVISED",
      "The halfway revision was already recorded"
    );
  }
  if (input.now < halfwayAt(openMs)) {
    throw new CallLifecycleError(
      "TOO_EARLY_TO_REVISE",
      "The revision checkpoint has not started"
    );
  }
  if (!isHalfwayCheckpoint(input.now, openMs)) {
    throw new CallLifecycleError(
      "CHECKPOINT_PASSED",
      `The halfway checkpoint lasts ${CHECKPOINT_TOLERANCE_MS / 1000}s and has passed; the call is final`
    );
  }

  const decision = buildDecision(input, "last_vs_strike");
  const effect = decision.call === existing.initial.call ? "keep" : "flip";
  const revision: CallRevision = {
    ...decision,
    effect,
    initialCall: existing.initial.call,
    why: `${decision.why} Initial call ${existing.initial.call}. ${effect === "keep" ? "Kept." : "Flipped."}`,
  };
  ledger.append({ type: "revision", windowId: id, revision });
  return stateFor(ledger, id, input.ticker)!;
}

/**
 * Append settlement. Scores the initial call and the final call.
 * Does not change either decision.
 */
export function settleCall(
  ledger: CallLedger,
  ticker: string,
  openTime: string,
  closeTime: string,
  endPx: number,
  strike: number,
  now: number
): WindowCallState {
  const openMs = Date.parse(openTime);
  const closeMs = Date.parse(closeTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) {
    throw new CallLifecycleError("BAD_WINDOW", "Window open and close must be timestamps");
  }
  const canonicalOpen = new Date(openMs).toISOString();
  const canonicalClose = new Date(closeMs).toISOString();
  const id = windowCallId(ticker, canonicalOpen, canonicalClose);
  const existing = stateFor(ledger, id, ticker);
  if (!existing) {
    throw new CallLifecycleError("UNKNOWN_WINDOW", "No locked call to settle");
  }
  if (existing.settlement) {
    throw new CallLifecycleError("ALREADY_SETTLED", "Settlement was already recorded");
  }
  if (!Number.isFinite(endPx) || !Number.isFinite(strike) || strike <= 0) {
    throw new CallLifecycleError(
      "MISSING_SETTLEMENT_INPUT",
      "Settlement needs a verified end price and a published strike"
    );
  }
  const outcome = compareToStrike(endPx, strike);
  ledger.append({
    type: "settlement",
    windowId: id,
    settlement: {
      at: now,
      endPx,
      strike,
      outcome,
      initialHit: existing.initial.call === outcome,
      finalHit: existing.finalCall === outcome,
    },
  });
  return stateFor(ledger, id, ticker)!;
}

export type CallPhase = "pre_start" | "first_half" | "checkpoint" | "final";

export function callPhase(now: number, openMs: number): CallPhase {
  if (now < openMs) return "pre_start";
  if (now < halfwayAt(openMs)) return "first_half";
  if (isHalfwayCheckpoint(now, openMs)) return "checkpoint";
  return "final";
}

export type CycleAction =
  | {
      kind: "lock";
      at: number;
      ticker: string;
      windowId: string;
      call: Direction;
      quality: DataQuality;
      agreement: Agreement;
    }
  | {
      kind: "revision";
      at: number;
      ticker: string;
      windowId: string;
      effect: "keep" | "flip";
      initialCall: Direction;
      call: Direction;
      quality: DataQuality;
    }
  | {
      kind: "missed";
      at: number;
      ticker: string;
      windowId: string;
    }
  | {
      kind: "settlement";
      at: number;
      ticker: string;
      windowId: string;
      outcome: Direction;
      initialHit: boolean;
      finalHit: boolean;
    };

interface PreparedWindow {
  openMs: number;
  closeMs: number;
  id: string;
  input: Btc15CallInput;
}

function windowFlags(events: readonly LedgerEvent[], windowId: string): {
  initial: boolean;
  revision: boolean;
  settlement: boolean;
  missed: boolean;
} {
  const flags = { initial: false, revision: false, settlement: false, missed: false };
  for (const event of events) {
    if (event.windowId !== windowId) continue;
    flags[event.type] = true;
  }
  return flags;
}

function prepareWindows(inputs: Btc15CallInput[]): PreparedWindow[] {
  const byId = new Map<string, PreparedWindow>();
  for (const raw of inputs) {
    let prepared: ReturnType<typeof requireWindow>;
    try {
      prepared = requireWindow(raw);
    } catch (error) {
      if (error instanceof CallLifecycleError && error.code === "BAD_WINDOW") continue;
      throw error;
    }
    const closeMs = Date.parse(prepared.input.closeTime);
    const next: PreparedWindow = {
      openMs: prepared.openMs,
      closeMs,
      id: prepared.id,
      input: prepared.input,
    };
    const prev = byId.get(prepared.id);
    if (!prev) {
      byId.set(prepared.id, next);
      continue;
    }
    prev.input = {
      ...prev.input,
      floorStrike: verifiedStrike(next.input.floorStrike) ?? prev.input.floorStrike,
      expirationValue:
        verifiedStrike(next.input.expirationValue) ??
        verifiedStrike(prev.input.expirationValue) ??
        null,
      spot: next.input.spot ?? prev.input.spot,
      bars: next.input.bars.length ? next.input.bars : prev.input.bars,
      now: next.input.now,
    };
  }
  return [...byId.values()].sort(
    (a, b) => a.openMs - b.openMs || a.input.ticker.localeCompare(b.input.ticker)
  );
}

/**
 * One pass over the windows the caller can see.
 *
 * The only future window that can be locked is the soonest one, and only
 * when its open is within LOCK_LEAD_MS. Listing more future windows does
 * not lock them. A window first seen after open is recorded as missed
 * inside the lookback; it is not locked late. Halfway allows one
 * keep-or-flip when a pre-start lock exists. Settlement is appended only
 * after Kalshi publishes expiration_value for a window that was locked.
 */
export function runBtc15Cycle(
  ledger: CallLedger,
  inputs: Btc15CallInput[]
): CycleAction[] {
  const windows = prepareWindows(inputs);
  let next: PreparedWindow | null = null;
  for (const window of windows) {
    if (window.openMs <= window.input.now) continue;
    if (!next || window.openMs < next.openMs) next = window;
  }

  const actions: CycleAction[] = [];
  for (const window of windows) {
    const { input, openMs, closeMs, id } = window;
    const lead = openMs - input.now;
    let flags = windowFlags(ledger.all(), id);

    const lockThis =
      next != null &&
      next.id === id &&
      lead > 0 &&
      lead <= LOCK_LEAD_MS &&
      !flags.initial &&
      !flags.missed;
    if (lockThis) {
      const before = ledger.all().length;
      const state = lockInitialCall(ledger, input);
      if (ledger.all().length > before) {
        actions.push({
          kind: "lock",
          at: state.initial.at,
          ticker: input.ticker,
          windowId: id,
          call: state.initial.call,
          quality: state.initial.quality,
          agreement: state.initial.agreement,
        });
      }
      flags = windowFlags(ledger.all(), id);
    }

    if (callPhase(input.now, openMs) === "checkpoint" && flags.initial && !flags.revision) {
      const before = ledger.all().length;
      const state = reviseAtHalfway(ledger, input);
      if (ledger.all().length > before && state.revision) {
        actions.push({
          kind: "revision",
          at: state.revision.at,
          ticker: input.ticker,
          windowId: id,
          effect: state.revision.effect,
          initialCall: state.revision.initialCall,
          call: state.revision.call,
          quality: state.revision.quality,
        });
      }
      flags = windowFlags(ledger.all(), id);
    }

    const opened = input.now >= openMs;
    const inMissedScope = opened && input.now < closeMs + MISSED_LOOKBACK_MS;
    if (opened && inMissedScope && !flags.initial && !flags.missed) {
      ledger.append({
        type: "missed",
        windowId: id,
        missed: {
          at: input.now,
          reason: MISSED_REASON,
          openTime: input.openTime,
          closeTime: input.closeTime,
          ticker: input.ticker,
        },
      });
      actions.push({
        kind: "missed",
        at: input.now,
        ticker: input.ticker,
        windowId: id,
      });
      flags = windowFlags(ledger.all(), id);
    }

    const expiration = verifiedStrike(input.expirationValue);
    const strike = verifiedStrike(input.floorStrike);
    if (
      flags.initial &&
      !flags.settlement &&
      input.now >= closeMs &&
      expiration != null &&
      strike != null
    ) {
      const before = ledger.all().length;
      const state = settleCall(
        ledger,
        input.ticker,
        input.openTime,
        input.closeTime,
        expiration,
        strike,
        input.now
      );
      if (ledger.all().length > before && state.settlement) {
        actions.push({
          kind: "settlement",
          at: state.settlement.at,
          ticker: input.ticker,
          windowId: id,
          outcome: state.settlement.outcome,
          initialHit: state.settlement.initialHit,
          finalHit: state.settlement.finalHit,
        });
      }
    }
  }
  return actions;
}

/**
 * Same cycle as the unattended runner. A pre-start window is locked only
 * when it is the single next window and its open is inside the lead.
 * A late poll cannot invent a lock.
 */
export function advanceBtc15Calls(
  ledger: CallLedger,
  inputs: Btc15CallInput[]
): CycleAction[] {
  return runBtc15Cycle(ledger, inputs);
}

/** Delay until the next loop tick. Errors back off; success returns to the base cadence. */
export function nextTickDelay(prevDelayMs: number, hadError: boolean): number {
  if (!hadError) return LOOP_TICK_MS;
  const base = Math.max(prevDelayMs, LOOP_TICK_MS);
  return Math.min(base * 2, LOOP_BACKOFF_CAP_MS);
}

/** One stdout line for a ledger change. No line when the cycle changes nothing. */
export function formatActionLine(action: CycleAction): string {
  const iso = new Date(action.at).toISOString();
  switch (action.kind) {
    case "lock":
      return `${iso} LOCK ${action.ticker} ${action.call} quality=${action.quality} agreement=${action.agreement}`;
    case "revision":
      return `${iso} REVISE ${action.ticker} ${action.effect === "keep" ? "KEEP" : "FLIP"} ${action.initialCall} -> ${action.call} quality=${action.quality}`;
    case "settlement":
      return `${iso} SETTLE ${action.ticker} outcome=${action.outcome} initialHit=${action.initialHit} finalHit=${action.finalHit}`;
    case "missed":
      return `${iso} MISSED ${action.ticker} no pre-start lock`;
  }
}

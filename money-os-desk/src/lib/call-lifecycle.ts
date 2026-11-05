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
  type PriceSource,
  type QualityParts,
  type StrikeSource,
  type WindowCallState,
} from "./call-ledger";

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

/**
 * Lock a window that has not opened, and revise a window that is inside
 * its halfway checkpoint. Does nothing in the other phases, including
 * after the checkpoint, so a late poll cannot change the call.
 */
export function advanceBtc15Calls(
  ledger: CallLedger,
  inputs: Btc15CallInput[]
): WindowCallState[] {
  const out: WindowCallState[] = [];
  for (const raw of inputs) {
    const { openMs, id, input } = requireWindow(raw);
    const phase = callPhase(input.now, openMs);
    if (phase === "pre_start") {
      out.push(lockInitialCall(ledger, input));
    } else if (phase === "checkpoint") {
      const existing = stateFor(ledger, id, input.ticker);
      if (existing && !existing.revision) out.push(reviseAtHalfway(ledger, input));
      else if (existing) out.push(existing);
    } else {
      const existing = stateFor(ledger, id, input.ticker);
      if (existing) out.push(existing);
    }
  }
  return out;
}

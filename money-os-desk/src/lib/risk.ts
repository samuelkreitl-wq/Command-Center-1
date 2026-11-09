/**
 * Shared limit-fill and stop-loss rules.
 * Paper and the server monitor both call these functions.
 * This module does not sign requests and does not import the live executor.
 */

export type LimitAction = "buy" | "sell";

export type LimitQuote = {
  bid: number | null;
  ask: number | null;
};

export type LimitStatus = "resting" | "filled" | "cancelled" | "expired";

export type LimitView = {
  action: LimitAction;
  limit: number;
  cancelled: boolean;
  /** Window close, in epoch ms. A non-finite value does not expire the order. */
  expiresAt: number;
};

export type LimitDecision = {
  status: LimitStatus;
  fillPrice: number | null;
};

export type StopSpec = {
  /** Fraction of entry value. 0.2 means a 20% drop. */
  percent: number | null;
  /** Drop in position value, in dollars: count × (entry − mark). */
  dollars: number | null;
};

export type StopReason = "percent" | "dollars" | "percent_and_dollars";

export type StopDecision = {
  fire: boolean;
  reason: StopReason | null;
  price: number | null;
  dropDollars: number | null;
  dropPercent: number | null;
};

/** A quote older than this is stale. Stale quotes never trigger a stop or a limit fill. */
export const RISK_QUOTE_MAX_AGE_MS = 30_000;

export function quoteIsStale(observedAt: number | null, now: number, maxAgeMs = RISK_QUOTE_MAX_AGE_MS): boolean {
  if (observedAt == null || !Number.isFinite(observedAt)) return true;
  if (observedAt > now + 5_000) return true;
  return now - observedAt > maxAgeMs;
}

function usable(price: number | null): price is number {
  return typeof price === "number" && Number.isFinite(price) && price > 0 && price < 1;
}

/**
 * A buy rests until the ask is at or below the limit, then fills at the ask.
 * A sell rests until the bid is at or above the limit, then fills at the bid.
 * At the limit fills. Through the limit fills. Not reaching the limit stays resting.
 * Cancel wins over a touch. At or after expiry the order expires and does not fill.
 */
export function evaluateLimit(order: LimitView, quote: LimitQuote, now: number): LimitDecision {
  if (order.cancelled) return { status: "cancelled", fillPrice: null };
  if (Number.isFinite(order.expiresAt) && now >= order.expiresAt) return { status: "expired", fillPrice: null };
  if (!(order.limit > 0) || order.limit >= 1) return { status: "resting", fillPrice: null };
  if (order.action === "buy") {
    if (!usable(quote.ask) || quote.ask > order.limit) return { status: "resting", fillPrice: null };
    return { status: "filled", fillPrice: quote.ask };
  }
  if (!usable(quote.bid) || quote.bid < order.limit) return { status: "resting", fillPrice: null };
  return { status: "filled", fillPrice: quote.bid };
}

function usableStopNumber(value: number | null, hi: number): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0 || value > hi) return null;
  return value;
}

export function normalizeStop(stop: StopSpec | null | undefined): StopSpec | null {
  if (!stop) return null;
  const percent = usableStopNumber(stop.percent, 1);
  const dollars = usableStopNumber(stop.dollars, 1_000_000);
  if (percent == null && dollars == null) return null;
  return { percent, dollars };
}

/**
 * Position value is count × price. The mark is the live bid of the held side.
 * A percent stop and a dollar stop are independent. If both are set, either one fires.
 * Stale data and a second look at an already-fired stop do not fire.
 */
export function evaluateStop(input: {
  entry: number;
  count: number;
  mark: number | null;
  stop: StopSpec | null;
  stale: boolean;
  alreadyFired: boolean;
}): StopDecision {
  const quiet: StopDecision = { fire: false, reason: null, price: null, dropDollars: null, dropPercent: null };
  if (input.alreadyFired || input.stale) return quiet;
  const stop = normalizeStop(input.stop);
  if (!stop) return quiet;
  if (!(input.entry > 0) || input.entry >= 1 || !Number.isInteger(input.count) || input.count < 1) return quiet;
  if (!usable(input.mark)) return quiet;
  const dropDollars = input.count * (input.entry - input.mark);
  const dropPercent = (input.entry - input.mark) / input.entry;
  const percentHit = stop.percent != null && dropPercent >= stop.percent - 1e-12;
  const dollarsHit = stop.dollars != null && dropDollars >= stop.dollars - 1e-9;
  if (!percentHit && !dollarsHit) {
    return { fire: false, reason: null, price: input.mark, dropDollars, dropPercent };
  }
  const reason: StopReason = percentHit && dollarsHit ? "percent_and_dollars" : percentHit ? "percent" : "dollars";
  return { fire: true, reason, price: input.mark, dropDollars, dropPercent };
}

export function describeStop(stop: StopSpec | null | undefined): string {
  const normalized = normalizeStop(stop);
  if (!normalized) return "No stop-loss. Confirming does not pre-authorize an exit.";
  const parts: string[] = [];
  if (normalized.percent != null) parts.push(`${(normalized.percent * 100).toFixed(1)}%`);
  if (normalized.dollars != null) parts.push(`$${normalized.dollars.toFixed(2)}`);
  const which = parts.length > 1 ? ", whichever happens first" : "";
  return `Stop-loss: exit if this position's value drops ${parts.join(" or ")} from entry${which}. Confirming this entry pre-authorizes that exit.`;
}

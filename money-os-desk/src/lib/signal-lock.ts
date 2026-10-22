/**
 * Immutable core lock + separate scalp + audited override events.
 * Core lock for a window is never rewritten.
 */

import type { CoreLock, Direction, MarketWindow, ScalpState, SignalAction } from "./types";

export function windowId(ticker: string, closeTime: string): string {
  return `${ticker}::${closeTime}`;
}

/** First write wins. Later calls with same windowId are ignored. */
export function lockCore(
  existing: CoreLock | null,
  next: {
    ticker: string;
    market: MarketWindow;
    closeTime: string;
    lockedCall: Direction;
    confidence: number;
    startPx: number;
    strike: number;
    action: SignalAction;
    factors: string[];
    lockedAt?: number;
  }
): CoreLock {
  const id = windowId(next.ticker, next.closeTime);
  if (existing && existing.windowId === id) {
    return existing;
  }
  return {
    windowId: id,
    ticker: next.ticker,
    market: next.market,
    lockedCall: next.lockedCall,
    confidence: next.confidence,
    lockedAt: next.lockedAt ?? Date.now(),
    startPx: next.startPx,
    strike: next.strike,
    closeTime: next.closeTime,
    action: next.action,
    factors: [...next.factors],
  };
}

/** Scalp never mutates CoreLock. */
export function updateScalp(core: CoreLock, lean: Direction | null): ScalpState {
  return {
    windowId: core.windowId,
    lean,
    updatedAt: Date.now(),
  };
}

export interface OverrideEvent {
  windowId: string;
  previousCall: Direction;
  newCall: Direction;
  reason: string;
  at: number;
}

/**
 * Does not mutate core. Returns audit event only.
 * Caller may open a *new* tracking series; original core stays for win-rate.
 */
export function requestOverride(
  core: CoreLock,
  newCall: Direction,
  reason: string
): OverrideEvent {
  const r = reason.trim();
  if (!r) throw new Error("Override requires a non-empty reason");
  return {
    windowId: core.windowId,
    previousCall: core.lockedCall,
    newCall,
    reason: r,
    at: Date.now(),
  };
}

/** Settle core once. Idempotent. Outcome = endPx >= strike → UP. */
export function settleCore(lock: CoreLock, endPx: number): CoreLock {
  if (lock.settledAt) return lock;
  const outcome: Direction = endPx >= lock.strike ? "UP" : "DOWN";
  const hit = outcome === lock.lockedCall;
  return {
    ...lock,
    settledAt: Date.now(),
    outcome,
    endPx,
    hit,
    postmortem: hit
      ? `HIT. ${lock.lockedCall}; ${lock.startPx} → ${endPx} vs strike ${lock.strike}`
      : `MISS. Called ${lock.lockedCall}; ${lock.startPx} → ${endPx} vs strike ${lock.strike}`,
  };
}

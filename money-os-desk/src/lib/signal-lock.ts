/**
 * Immutable core lock + separate scalp + audited override events.
 * Core lock for a window is never rewritten.
 */

import type { CallRevision, CoreLock, Direction, MarketWindow, ScalpState, SignalAction } from "./types";

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
    openTime?: string;
    lockTiming?: CoreLock["lockTiming"];
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
    ...(next.openTime ? { openTime: next.openTime } : {}),
    ...(next.lockTiming ? { lockTiming: next.lockTiming } : {}),
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

/** Append an auditable revision without changing the original opening call. */
export function reviseCoreCall(
  core: CoreLock,
  revisedCall: Direction,
  reason: string,
  observedPrice: number,
  confidence: number,
  revisedAt = Date.now(),
): CoreLock {
  if (core.settledAt) throw new Error("A settled call cannot be revised");
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3) throw new Error("Add a short reason for the correction");
  if (!Number.isFinite(observedPrice) || observedPrice <= 0) {
    throw new Error("A valid live price is required to revise a call");
  }
  const previousCall = core.revisions?.at(-1)?.revisedCall ?? core.lockedCall;
  if (previousCall === revisedCall) throw new Error("Choose the opposite of the current call");
  const revision: CallRevision = {
    previousCall,
    revisedCall,
    revisedAt,
    reason: trimmedReason,
    observedPrice,
    confidence,
  };
  return {
    ...core,
    revisions: [...(core.revisions ?? []), revision],
    finalCall: revisedCall,
  };
}

/** Settle core once. Idempotent. Outcome = endPx >= strike → UP. */
export function settleCore(lock: CoreLock, endPx: number): CoreLock {
  if (lock.settledAt) return lock;
  const outcome: Direction = endPx >= lock.strike ? "UP" : "DOWN";
  const hit = outcome === lock.lockedCall;
  const finalCall = lock.revisions?.at(-1)?.revisedCall ?? lock.lockedCall;
  return {
    ...lock,
    settledAt: Date.now(),
    outcome,
    endPx,
    hit,
    ...(lock.revisions?.length ? { finalCall, finalHit: outcome === finalCall } : {}),
    postmortem: hit
      ? `HIT. ${lock.lockedCall} @ ${lock.confidence}%; ${lock.startPx} → ${endPx} vs strike ${lock.strike}`
      : `MISS. Called ${lock.lockedCall} @ ${lock.confidence}%; ${lock.startPx} → ${endPx} vs strike ${lock.strike}`,
  };
}

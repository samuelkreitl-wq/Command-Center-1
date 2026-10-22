/**
 * Strike comparison for a BTC15 call.
 *
 * AT STRIKE is a one-cent band, the same precision Kalshi uses when it rounds
 * the BRTI average. Equality is inside the band, so it is AT STRIKE rather than UP.
 * This is the desk's call rule. The KXBTC15M contract itself is greater_or_equal:
 * an exact tie settles Yes. Paper settlement still follows that contract rule.
 */

import type { Direction } from "./types";

/** Half-width of the AT STRIKE band, in USD. */
export const AT_STRIKE_EPSILON_USD = 0.01;

export const WINDOW_MS = 15 * 60 * 1000;
/** Halfway checkpoint is 7.5 minutes after the window opens. */
export const HALFWAY_MS = 7.5 * 60 * 1000;
/**
 * A revision is accepted only inside this window starting at halfway.
 * The feed polls about every 8s, so 60s is enough for one checkpoint
 * and still closes the call before the rest of the second half.
 */
export const CHECKPOINT_TOLERANCE_MS = 60 * 1000;

/** Quote age at or under this is LIVE. Older verified quotes are STALE. */
export const QUOTE_LIVE_MS = 15_000;
/** Last closed 1m bar must have ended within this to be LIVE. */
export const BAR_LIVE_MS = 120_000;
/** EMA21 needs 21 closed bars. Fewer than this is NO DATA for the bar set. */
export const MIN_CLOSED_BARS = 21;

/** Nearest cent. The band is applied in integer cents so 0.01 does not spill past the edge. */
export function toCents(n: number): number {
  return Math.round(n * 100);
}

export function compareToStrike(price: number, strike: number): Direction {
  const deltaCents = toCents(price) - toCents(strike);
  const bandCents = Math.round(AT_STRIKE_EPSILON_USD * 100);
  if (Math.abs(deltaCents) <= bandCents) return "AT STRIKE";
  return deltaCents > 0 ? "UP" : "DOWN";
}

export function halfwayAt(openMs: number): number {
  return openMs + HALFWAY_MS;
}

export function isHalfwayCheckpoint(now: number, openMs: number): boolean {
  const start = halfwayAt(openMs);
  return now >= start && now < start + CHECKPOINT_TOLERANCE_MS;
}

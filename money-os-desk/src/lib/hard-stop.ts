import type { CoreLock, HardStopState } from "./types";

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

export function evaluateHardStop(
  locks: CoreLock[],
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS
): HardStopState {
  const settled = locks
    .filter((r) => r.settledAt && r.hit != null)
    .sort((a, b) => (b.settledAt! - a.settledAt!));

  const last = settled[0];
  if (!last) {
    return { active: false, reason: "No settled locks" };
  }
  if (last.hit) {
    return { active: false, reason: "Last settle was a hit" };
  }

  const until = last.settledAt! + cooldownMs;
  if (now < until) {
    return {
      active: true,
      until,
      reason: `Hard-stop after miss on ${last.ticker}`,
      lastMissTicker: last.ticker,
    };
  }
  return {
    active: false,
    reason: "Cooldown elapsed after miss",
    lastMissTicker: last.ticker,
  };
}

/** 5m markets: one window cooldown */
export function cooldownForMarket(market: "15m" | "5m"): number {
  return market === "5m" ? 5 * 60 * 1000 : 15 * 60 * 1000;
}

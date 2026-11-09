/**
 * Read-only safety net. It never sells, never places an order, and never touches the
 * confirm gate. Thresholds are the defaults below and can be overridden from the environment.
 *
 * DANGER (any one is enough):
 *   (a) 3-day point return <= -7%
 *   (b) 3-day 90% lower bound <= -15%
 *   (c) P(drop >= 10% within 3 days) >= 25%
 *   (d) long bias and short tape are both DOWNHILL and the minute tape is accelerating down
 * WATCH is the same four checks at milder thresholds. Both-downhill without acceleration is WATCH.
 * Condition (d) uses the same acceleration statistic as the conflict deep-read. Both-downhill
 * is the aligned path, so the deep write-up itself does not run; the number is still measured.
 */

export type SafetyLevel = "none" | "watch" | "danger";

export type SafetyThresholds = {
  dangerPoint: number;
  dangerLower90: number;
  dangerP10: number;
  watchPoint: number;
  watchLower90: number;
  watchP10: number;
  accel: number;
};

export const DEFAULT_SAFETY_THRESHOLDS: SafetyThresholds = {
  dangerPoint: -0.07,
  dangerLower90: -0.15,
  dangerP10: 0.25,
  watchPoint: -0.04,
  watchLower90: -0.10,
  watchP10: 0.15,
  accel: 0.0001,
};

export type SafetyTrigger = {
  id: "point" | "lower90" | "p10" | "downhill";
  level: "watch" | "danger";
  detail: string;
};

export function readSafetyThresholds(env: Record<string, string | undefined> = process.env): SafetyThresholds {
  const num = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    dangerPoint: num("SAFETY_DANGER_POINT", DEFAULT_SAFETY_THRESHOLDS.dangerPoint),
    dangerLower90: num("SAFETY_DANGER_LOWER90", DEFAULT_SAFETY_THRESHOLDS.dangerLower90),
    dangerP10: num("SAFETY_DANGER_P10", DEFAULT_SAFETY_THRESHOLDS.dangerP10),
    watchPoint: num("SAFETY_WATCH_POINT", DEFAULT_SAFETY_THRESHOLDS.watchPoint),
    watchLower90: num("SAFETY_WATCH_LOWER90", DEFAULT_SAFETY_THRESHOLDS.watchLower90),
    watchP10: num("SAFETY_WATCH_P10", DEFAULT_SAFETY_THRESHOLDS.watchP10),
    accel: num("SAFETY_ACCEL", DEFAULT_SAFETY_THRESHOLDS.accel),
  };
}

export function evaluateSafety(input: {
  pointReturn: number | null;
  lower90Return: number | null;
  pDrop10: number | null;
  longBias: "UPHILL" | "DOWNHILL" | "FLAT" | null;
  shortTape: "UPHILL" | "DOWNHILL" | "FLAT" | "MIXED" | null;
  acceleration: number | null;
  thresholds?: Partial<SafetyThresholds>;
}): { level: SafetyLevel; active: SafetyTrigger[] } {
  const t = { ...DEFAULT_SAFETY_THRESHOLDS, ...input.thresholds };
  const active: SafetyTrigger[] = [];
  if (input.pointReturn != null) {
    if (input.pointReturn <= t.dangerPoint) active.push({ id: "point", level: "danger", detail: `3-day point ${(input.pointReturn * 100).toFixed(1)}% vs current (danger ${t.dangerPoint * 100}%)` });
    else if (input.pointReturn <= t.watchPoint) active.push({ id: "point", level: "watch", detail: `3-day point ${(input.pointReturn * 100).toFixed(1)}% vs current (watch ${t.watchPoint * 100}%)` });
  }
  if (input.lower90Return != null) {
    if (input.lower90Return <= t.dangerLower90) active.push({ id: "lower90", level: "danger", detail: `3-day 90% lower bound ${(input.lower90Return * 100).toFixed(1)}% (danger ${t.dangerLower90 * 100}%)` });
    else if (input.lower90Return <= t.watchLower90) active.push({ id: "lower90", level: "watch", detail: `3-day 90% lower bound ${(input.lower90Return * 100).toFixed(1)}% (watch ${t.watchLower90 * 100}%)` });
  }
  if (input.pDrop10 != null) {
    if (input.pDrop10 >= t.dangerP10) active.push({ id: "p10", level: "danger", detail: `P(drop ≥ 10% in 3 days) ${(input.pDrop10 * 100).toFixed(1)}% (danger ${t.dangerP10 * 100}%)` });
    else if (input.pDrop10 >= t.watchP10) active.push({ id: "p10", level: "watch", detail: `P(drop ≥ 10% in 3 days) ${(input.pDrop10 * 100).toFixed(1)}% (watch ${t.watchP10 * 100}%)` });
  }
  const bothDown = input.longBias === "DOWNHILL" && input.shortTape === "DOWNHILL";
  if (bothDown && input.acceleration != null && input.acceleration < -t.accel) {
    active.push({ id: "downhill", level: "danger", detail: `Long and short timeframes are DOWNHILL and the minute tape is accelerating down (${input.acceleration.toExponential(2)}).` });
  } else if (bothDown) {
    active.push({ id: "downhill", level: "watch", detail: "Long and short timeframes are both DOWNHILL. Acceleration has not reached the danger line." });
  }
  const level: SafetyLevel = active.some((item) => item.level === "danger") ? "danger" : active.length ? "watch" : "none";
  return { level, active };
}

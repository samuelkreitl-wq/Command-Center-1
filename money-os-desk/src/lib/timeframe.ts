/**
 * One engine for 6M, 3M, 1W, 1D, 1H, and the minute tape.
 * Direction is the OLS slope of log(close) over the sample.
 * FLAT means the fitted log-return is within ±0.20%. FLAT does not vote.
 * A FLAT short tape does not conflict with a long bias. A FLAT long bias is not a direction,
 * so the path stays aligned and the deep write-up does not run.
 *
 * Cache: 6M and 3M recompute at most daily. 1W and 1D recompute at most hourly.
 * 1H and the minute tape recompute on every decision. Their projections refresh with them.
 * A failed refresh of an expired cache is returned as STALE and does not pretend a new direction.
 */

import { classifySlope, type SlopeFit } from "./projection";

export type TfId = "6M" | "3M" | "1W" | "1D" | "1H" | "M";
export type Bias = "UPHILL" | "DOWNHILL" | "FLAT";

export const FLAT_ABS_LOG_RETURN = 0.002;

export const TF_ORDER: TfId[] = ["6M", "3M", "1W", "1D", "1H", "M"];
export const LONG_FRAMES: TfId[] = ["6M", "3M", "1W", "1D"];
export const SHORT_FRAMES: TfId[] = ["1H", "M"];

/** Documented refresh cadence. Zero means every decision. */
export const REFRESH_MS: Record<TfId, number> = {
  "6M": 24 * 60 * 60 * 1000,
  "3M": 24 * 60 * 60 * 1000,
  "1W": 60 * 60 * 1000,
  "1D": 60 * 60 * 1000,
  "1H": 0,
  M: 0,
};

export const TF_INTERVAL_MS: Record<TfId, number> = {
  "6M": 86_400_000,
  "3M": 86_400_000,
  "1W": 86_400_000,
  "1D": 3_600_000,
  "1H": 300_000,
  M: 60_000,
};

export function classifyCloses(closes: number[]): SlopeFit & { direction: Bias; insufficient: boolean } {
  const fit = classifySlope(closes);
  if (fit.points < 3) return { ...fit, direction: "FLAT", insufficient: true };
  let direction: Bias = "FLAT";
  if (fit.fittedLogReturn > FLAT_ABS_LOG_RETURN) direction = "UPHILL";
  else if (fit.fittedLogReturn < -FLAT_ABS_LOG_RETURN) direction = "DOWNHILL";
  return { ...fit, direction, insufficient: false };
}

export type FrameSnapshot = {
  id: TfId;
  direction: Bias | null;
  stale: boolean;
  computedAt: number | null;
  ageMs: number | null;
  fittedLogReturn: number | null;
  slopePerBar: number | null;
  points: number;
  fromCache: boolean;
};

export type CacheEntry = {
  computedAt: number;
  direction: Bias;
  fittedLogReturn: number;
  slopePerBar: number;
  points: number;
  projection: unknown;
};

export function longBias(frames: FrameSnapshot[]): Bias {
  const votes = frames.filter((frame) => LONG_FRAMES.includes(frame.id) && !frame.stale && (frame.direction === "UPHILL" || frame.direction === "DOWNHILL"));
  const up = votes.filter((frame) => frame.direction === "UPHILL").length;
  const down = votes.filter((frame) => frame.direction === "DOWNHILL").length;
  if (up > down) return "UPHILL";
  if (down > up) return "DOWNHILL";
  return "FLAT";
}

export function shortTape(frames: FrameSnapshot[]): Bias | "MIXED" {
  const hour = frames.find((frame) => frame.id === "1H");
  const minutes = frames.find((frame) => frame.id === "M");
  const dirs = [hour, minutes].map((frame) => (frame && !frame.stale ? frame.direction : null));
  const live = dirs.filter((dir): dir is Bias => dir === "UPHILL" || dir === "DOWNHILL" || dir === "FLAT");
  const directional = live.filter((dir) => dir !== "FLAT");
  if (!directional.length) return "FLAT";
  if (directional.every((dir) => dir === directional[0])) return directional[0];
  return "MIXED";
}

/** Deep analysis runs only when the short tape disagrees with a directional long bias. */
export function analysisPath(bias: Bias, tape: Bias | "MIXED"): "aligned" | "conflict" {
  if (bias !== "UPHILL" && bias !== "DOWNHILL") return "aligned";
  if (tape === "FLAT") return "aligned";
  if (tape === "MIXED") return "conflict";
  return tape === bias ? "aligned" : "conflict";
}

export function tapeAcceleration(closes: number[]): number | null {
  if (closes.length < 20) return null;
  const recent = classifyCloses(closes.slice(-15));
  const prior = classifyCloses(closes.slice(-30, -15));
  if (recent.insufficient || prior.insufficient) return null;
  return recent.slopePerBar - prior.slopePerBar;
}

export type DeepRead = {
  notes: string[];
  acceleration: number | null;
  volRegime: "expanding" | "contracting" | "steady" | "unknown";
  reversal: boolean;
  distanceSigma: number | null;
};

export function deepRead(input: {
  minuteCloses: number[];
  hourDirection: Bias | null;
  spot: number;
  strike: number | null;
  sigma1m: number;
  minutesRemaining: number;
}): DeepRead {
  const acceleration = tapeAcceleration(input.minuteCloses);
  const returns = input.minuteCloses.length > 2
    ? input.minuteCloses.slice(1).map((close, i) => Math.log(close / input.minuteCloses[i])).filter((value) => Number.isFinite(value))
    : [];
  const recent = returns.slice(-15);
  const vol = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const avg = xs.reduce((s, v) => s + v, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, v) => s + (v - avg) ** 2, 0) / (xs.length - 1));
  };
  const recentVol = vol(recent);
  const fullVol = vol(returns);
  let volRegime: DeepRead["volRegime"] = "unknown";
  if (fullVol > 0) {
    const ratio = recentVol / fullVol;
    volRegime = ratio > 1.25 ? "expanding" : ratio < 0.8 ? "contracting" : "steady";
  }
  const last5 = classifyCloses(input.minuteCloses.slice(-6));
  const reversal = !!input.hourDirection && input.hourDirection !== "FLAT" && !last5.insufficient &&
    ((input.hourDirection === "UPHILL" && last5.direction === "DOWNHILL") ||
      (input.hourDirection === "DOWNHILL" && last5.direction === "UPHILL"));
  const expected = input.spot * input.sigma1m * Math.sqrt(Math.max(input.minutesRemaining, 1));
  const distanceSigma = input.strike != null && expected > 0 ? (input.spot - input.strike) / expected : null;
  const notes = [
    "Conflict path: the short tape disagrees with the long bias, so the hour and minute tape were read again.",
    `Acceleration (last 15 bars minus the prior 15) is ${acceleration == null ? "unavailable" : acceleration.toExponential(2)} log per bar.`,
    `Volatility regime: ${volRegime}.`,
    reversal ? "The last few minutes reverse the hour direction." : "No recent reversal against the hour.",
    distanceSigma == null ? "No official strike to compare with the expected move." : `Spot is ${distanceSigma.toFixed(2)} expected-moves from the strike.`,
  ];
  return { notes, acceleration, volRegime, reversal, distanceSigma };
}

export async function evaluateTimeframes(opts: {
  now: number;
  cache: Partial<Record<TfId, CacheEntry>>;
  load: (id: TfId) => Promise<{ closes: number[] } | null>;
  deep?: (ctx: { minuteCloses: number[]; hourDirection: Bias | null; acceleration: number | null }) => DeepRead;
}): Promise<{
  frames: FrameSnapshot[];
  cache: Partial<Record<TfId, CacheEntry>>;
  longBias: Bias;
  shortTape: Bias | "MIXED";
  path: "aligned" | "conflict";
  deep: DeepRead | null;
  minuteCloses: number[];
  acceleration: number | null;
}> {
  const nextCache: Partial<Record<TfId, CacheEntry>> = { ...opts.cache };
  const frames: FrameSnapshot[] = [];
  let minuteCloses: number[] = [];
  for (const id of TF_ORDER) {
    const cached = opts.cache[id] ?? null;
    const refresh = REFRESH_MS[id];
    const fresh = cached != null && (refresh === 0 ? false : opts.now - cached.computedAt < refresh);
    if (fresh && cached) {
      frames.push(frameFrom(id, cached, opts.now, true, false));
      continue;
    }
    try {
      const loaded = await opts.load(id);
      if (!loaded || loaded.closes.length < 3) throw new Error("short");
      if (id === "M") minuteCloses = loaded.closes;
      const classified = classifyCloses(loaded.closes);
      const entry: CacheEntry = {
        computedAt: opts.now,
        direction: classified.direction,
        fittedLogReturn: classified.fittedLogReturn,
        slopePerBar: classified.slopePerBar,
        points: classified.points,
        projection: null,
      };
      if (refresh !== 0) nextCache[id] = entry;
      frames.push(frameFrom(id, entry, opts.now, false, false));
    } catch {
      if (cached) frames.push(frameFrom(id, cached, opts.now, true, true));
      else frames.push({ id, direction: null, stale: true, computedAt: null, ageMs: null, fittedLogReturn: null, slopePerBar: null, points: 0, fromCache: false });
    }
  }
  if (!minuteCloses.length) {
    const loaded = await opts.load("M").catch(() => null);
    minuteCloses = loaded?.closes ?? [];
  }
  const bias = longBias(frames);
  const tape = shortTape(frames);
  const path = analysisPath(bias, tape);
  const acceleration = tapeAcceleration(minuteCloses);
  const hour = frames.find((frame) => frame.id === "1H");
  const deep = path === "conflict"
    ? (opts.deep ?? ((ctx) => deepRead({
      minuteCloses: ctx.minuteCloses,
      hourDirection: ctx.hourDirection,
      spot: 0,
      strike: null,
      sigma1m: 0,
      minutesRemaining: 15,
    })))({ minuteCloses, hourDirection: hour?.direction ?? null, acceleration })
    : null;
  return { frames, cache: nextCache, longBias: bias, shortTape: tape, path, deep, minuteCloses, acceleration };
}

function frameFrom(id: TfId, entry: CacheEntry, now: number, fromCache: boolean, stale: boolean): FrameSnapshot {
  return {
    id,
    direction: entry.direction,
    stale,
    computedAt: entry.computedAt,
    ageMs: Math.max(0, now - entry.computedAt),
    fittedLogReturn: entry.fittedLogReturn,
    slopePerBar: entry.slopePerBar,
    points: entry.points,
    fromCache,
  };
}

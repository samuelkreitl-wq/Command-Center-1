/**
 * Learning from settled paper calls.
 * Hit rates are Laplace smoothed. A timeframe or pattern with fewer than the
 * minimum sample does not move the next forecast. The probability shift is capped.
 * This module does not sign requests and does not import the live executor.
 */

import type { ConflictFlag, FrameReading, PaperEntry, PaperRow } from "./paper-book";

export const FRAME_IDS = ["6M", "3M", "1W", "1D", "1H", "M"] as const;
export type LearningFrameId = (typeof FRAME_IDS)[number];

export const FRAME_LABEL: Record<LearningFrameId, string> = {
  "6M": "6M",
  "3M": "3M",
  "1W": "1W",
  "1D": "1D",
  "1H": "1H",
  M: "minute tape",
};

export const LAPLACE_ALPHA = 1;
export const MIN_SAMPLE_SIZE = 5;
export const MAX_WEIGHT_SHIFT = 0.25;
export const MAX_PROBABILITY_SHIFT = 0.08;
export const PROBABILITY_FLOOR = 0.02;
export const PROBABILITY_CAP = 0.98;

const LONG_IDS: LearningFrameId[] = ["6M", "3M", "1W", "1D"];

export type SettledCall = {
  id: string;
  ticker: string;
  side: "yes" | "no";
  entry: number;
  probabilityAbove: number | null;
  frames: FrameReading[];
  conflicts: ConflictFlag[];
  correct: boolean;
  result: "yes" | "no";
  ts: number;
  source: "paper" | "recorded";
  reconstructed: boolean;
};

export type HitRate = {
  key: string;
  label: string;
  n: number;
  hits: number;
  rawHitRate: number | null;
  smoothed: number;
  trusted: boolean;
  weight: number;
};

export type LearningStats = {
  calls: number;
  recorded: number;
  reconstructed: number;
  overall: HitRate;
  byTimeframe: HitRate[];
  byPattern: HitRate[];
  minSamples: number;
  maxShift: number;
  method: string;
};

export type ForecastAdjustment = {
  raw: number;
  adjusted: number;
  delta: number;
  applied: boolean;
  reason: string;
  contributions: { key: string; delta: number; samples: number; smoothed: number; weight: number }[];
};

export function laplace(hits: number, n: number, alpha = LAPLACE_ALPHA): number {
  if (n <= 0) return 0.5;
  return (hits + alpha) / (n + 2 * alpha);
}

export function hitWeight(hits: number, n: number): { smoothed: number; trusted: boolean; weight: number } {
  const smoothed = laplace(hits, n);
  const trusted = n >= MIN_SAMPLE_SIZE;
  const weight = trusted ? clamp(1 + (smoothed - 0.5) * (MAX_WEIGHT_SHIFT / 0.5), 1 - MAX_WEIGHT_SHIFT, 1 + MAX_WEIGHT_SHIFT) : 1;
  return { smoothed, trusted, weight };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function rate(key: string, label: string, hits: number, n: number): HitRate {
  const weight = hitWeight(hits, n);
  return {
    key,
    label,
    n,
    hits,
    rawHitRate: n ? hits / n : null,
    smoothed: weight.smoothed,
    trusted: weight.trusted,
    weight: weight.weight,
  };
}

export function readProbability(entry: PaperEntry): number | null {
  if (typeof entry.forecastProbability === "number" && Number.isFinite(entry.forecastProbability)) return entry.forecastProbability;
  const forecast = entry.forecast as { probabilityAbove?: unknown } | null;
  const value = forecast && typeof forecast === "object" ? forecast.probabilityAbove : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function frameById(frames: FrameReading[], id: string): FrameReading | undefined {
  return frames.find((frame) => frame.id === id);
}

export function frameIsKnown(frame: FrameReading | undefined): boolean {
  if (!frame) return false;
  if (frame.known === false) return false;
  if (frame.direction == null) return false;
  return frame.direction === "UPHILL" || frame.direction === "DOWNHILL" || frame.direction === "FLAT" || frame.direction === "up" || frame.direction === "down" || frame.direction === "flat";
}

type DirWord = "up" | "down" | "flat" | "unknown";

function dirWord(frame: FrameReading | undefined): DirWord {
  if (!frameIsKnown(frame) || !frame) return "unknown";
  if (frame.direction === "UPHILL" || frame.direction === "up") return "up";
  if (frame.direction === "DOWNHILL" || frame.direction === "down") return "down";
  if (frame.direction === "FLAT" || frame.direction === "flat") return "flat";
  return "unknown";
}

function longWord(frames: FrameReading[]): DirWord {
  let up = 0;
  let down = 0;
  let known = 0;
  for (const id of LONG_IDS) {
    const word = dirWord(frameById(frames, id));
    if (word === "unknown") continue;
    known += 1;
    if (word === "up") up += 1;
    if (word === "down") down += 1;
  }
  if (!known) return "unknown";
  if (up > down) return "up";
  if (down > up) return "down";
  return "flat";
}

function patternOf(long: DirWord, other: DirWord, id: string): ConflictFlag {
  if (long === "unknown" || other === "unknown") {
    return { id, pattern: "unknown", known: false, reconstructed: false };
  }
  return { id, pattern: `long-term ${long} / ${id === "long_vs_minute" ? "minute" : "hour"} ${other}`, known: true };
}

/** Conflict strings such as "long-term up / minute down". Unknown readings stay unknown. */
export function conflictPatterns(frames: FrameReading[]): ConflictFlag[] {
  const long = longWord(frames);
  return [
    patternOf(long, dirWord(frameById(frames, "M")), "long_vs_minute"),
    patternOf(long, dirWord(frameById(frames, "1H")), "long_vs_hour"),
  ];
}

function directionMatched(direction: string | null, result: "yes" | "no"): boolean | null {
  if (direction === "UPHILL" || direction === "up") return result === "yes";
  if (direction === "DOWNHILL" || direction === "down") return result === "no";
  return null;
}

export function settledCalls(rows: PaperRow[]): SettledCall[] {
  const entries = new Map<string, PaperEntry>();
  for (const row of rows) {
    if (row.kind === "entry") entries.set(row.id, row);
  }
  const calls: SettledCall[] = [];
  for (const row of rows) {
    if (row.kind !== "settlement") continue;
    const entry = entries.get(row.entryId);
    if (!entry) continue;
    const frames = entry.frames.map((frame) => ({ ...frame }));
    const stored = entry.conflicts?.length ? entry.conflicts : conflictPatterns(frames);
    calls.push({
      id: entry.id,
      ticker: entry.ticker,
      side: entry.side,
      entry: entry.entry,
      probabilityAbove: readProbability(entry),
      frames,
      conflicts: stored,
      correct: row.correct,
      result: row.result,
      ts: row.ts,
      source: entry.source ?? "paper",
      reconstructed: entry.reconstructed === true,
    });
  }
  return calls;
}

export function learningStats(rows: PaperRow[]): LearningStats {
  const calls = settledCalls(rows);
  const overallHits = calls.filter((call) => call.correct).length;
  const frameBuckets = new Map<string, { hits: number; n: number }>();
  for (const id of FRAME_IDS) frameBuckets.set(id, { hits: 0, n: 0 });
  const patternBuckets = new Map<string, { hits: number; n: number }>();
  for (const call of calls) {
    for (const id of FRAME_IDS) {
      const frame = frameById(call.frames, id);
      if (!frameIsKnown(frame) || !frame) continue;
      const matched = directionMatched(frame.direction, call.result);
      if (matched == null) continue;
      const bucket = frameBuckets.get(id)!;
      bucket.n += 1;
      bucket.hits += matched ? 1 : 0;
    }
    for (const flag of call.conflicts) {
      if (!flag.known || flag.pattern === "unknown") continue;
      const bucket = patternBuckets.get(flag.pattern) ?? { hits: 0, n: 0 };
      bucket.n += 1;
      bucket.hits += call.correct ? 1 : 0;
      patternBuckets.set(flag.pattern, bucket);
    }
  }
  return {
    calls: calls.length,
    recorded: calls.filter((call) => call.source === "recorded").length,
    reconstructed: calls.filter((call) => call.reconstructed).length,
    overall: rate("overall", "Overall", overallHits, calls.length),
    byTimeframe: FRAME_IDS.map((id) => {
      const bucket = frameBuckets.get(id)!;
      return rate(id, FRAME_LABEL[id], bucket.hits, bucket.n);
    }),
    byPattern: [...patternBuckets.entries()]
      .map(([pattern, bucket]) => rate(pattern, pattern, bucket.hits, bucket.n))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)),
    minSamples: MIN_SAMPLE_SIZE,
    maxShift: MAX_PROBABILITY_SHIFT,
    method:
      "Laplace-smoothed hit rates (alpha 1). A timeframe or conflict pattern needs at least 5 settled samples before it can move a forecast. " +
      "Weights stay inside ±0.25 of neutral. The probability adjustment stays inside ±0.08 and is not applied when there is no trusted history. " +
      "Unknown or reconstructed-unknown readings stay in the overall tally and do not vote.",
  };
}

function boundAdjustment(raw: number, sum: number): number {
  if (!(raw > 0) || !(raw < 1) || Math.abs(sum) < 1e-12) return raw;
  const shifted = raw + clamp(sum, -MAX_PROBABILITY_SHIFT, MAX_PROBABILITY_SHIFT);
  const capped = clamp(shifted, PROBABILITY_FLOOR, PROBABILITY_CAP);
  if ((capped - raw) * sum < 0) return raw;
  return capped;
}

/**
 * Move the raw P(YES) toward timeframes and conflict patterns that have been right,
 * and away from the ones that have been wrong. No trusted history leaves the raw value unchanged.
 */
export function adjustForecast(input: {
  probabilityAbove: number;
  frames: FrameReading[];
  history: PaperRow[];
}): ForecastAdjustment {
  const raw = input.probabilityAbove;
  const stats = learningStats(input.history);
  const contributions: ForecastAdjustment["contributions"] = [];
  const scale = MAX_PROBABILITY_SHIFT / MAX_WEIGHT_SHIFT;
  for (const id of FRAME_IDS) {
    const frame = frameById(input.frames, id);
    const lean = frame && frameIsKnown(frame) ? directionMatched(frame.direction, "yes") : null;
    if (lean == null || !frame) continue;
    const bucket = stats.byTimeframe.find((item) => item.key === id);
    if (!bucket?.trusted) continue;
    const sign = lean ? 1 : frame.direction === "DOWNHILL" || frame.direction === "down" ? -1 : 0;
    if (!sign) continue;
    const delta = (bucket.weight - 1) * sign * scale;
    if (Math.abs(delta) < 1e-12) continue;
    contributions.push({ key: FRAME_LABEL[id], delta, samples: bucket.n, smoothed: bucket.smoothed, weight: bucket.weight });
  }
  const currentPatterns = input.frames.length ? conflictPatterns(input.frames) : [];
  const sideSign = raw > 0.5 ? 1 : raw < 0.5 ? -1 : 0;
  for (const flag of currentPatterns) {
    if (!flag.known || !sideSign) continue;
    const bucket = stats.byPattern.find((item) => item.key === flag.pattern);
    if (!bucket?.trusted) continue;
    const delta = (bucket.weight - 1) * sideSign * scale;
    if (Math.abs(delta) < 1e-12) continue;
    contributions.push({ key: flag.pattern, delta, samples: bucket.n, smoothed: bucket.smoothed, weight: bucket.weight });
  }
  const sum = contributions.reduce((total, item) => total + item.delta, 0);
  const adjusted = boundAdjustment(raw, sum);
  const delta = adjusted - raw;
  const applied = Math.abs(delta) >= 1e-12;
  const reason = applied
    ? `Adjusted ${(delta * 100).toFixed(1)} percentage points from the raw scenario using Laplace-smoothed hit rates with at least ${MIN_SAMPLE_SIZE} samples: ${contributions.map((item) => `${item.key} ${(item.delta * 100).toFixed(1)} pts (n=${item.samples}, smoothed ${(item.smoothed * 100).toFixed(0)}%)`).join("; ")}. The move is capped at ±${(MAX_PROBABILITY_SHIFT * 100).toFixed(0)} points.`
    : `No settled history meets the minimum sample of ${MIN_SAMPLE_SIZE} for the timeframes and conflict patterns in this scenario. The raw scenario is unchanged.`;
  return { raw, adjusted, delta, applied, reason, contributions };
}

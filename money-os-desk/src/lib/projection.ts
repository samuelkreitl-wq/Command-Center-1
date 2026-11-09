/**
 * Forward scenarios. Each timeframe's fitted log-price slope is extended over a matching
 * horizon (6 months for 6M). The band is residual one-step volatility times sqrt(steps).
 * This is a SCENARIO that assumes the slope holds. It is not a forecast of fact.
 *
 * Weights below are the only way a projection enters a 15-minute call. The minute tape
 * weight is 0. The applied nudge is capped at PROJECTION_SIGMA_CAP horizon sigmas.
 */

export const Z90 = 1.6448536269514722;

export type SlopeFit = {
  slopePerBar: number;
  intercept: number;
  fittedLogReturn: number;
  sigmaPerBar: number;
  points: number;
};

export function classifySlope(closes: number[]): SlopeFit {
  const y = closes.filter((value) => value > 0).map((value) => Math.log(value));
  const n = y.length;
  if (n < 2) return { slopePerBar: 0, intercept: y[0] ?? 0, fittedLogReturn: 0, sigmaPerBar: 0, points: n };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += y[i];
    sxx += i * i;
    sxy += i * y[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = sy / n - slope * (sx / n);
  const residuals: number[] = [];
  for (let i = 1; i < n; i++) residuals.push(y[i] - y[i - 1] - slope);
  const mean = residuals.reduce((sum, value) => sum + value, 0) / Math.max(1, residuals.length);
  const sigma = residuals.length > 1
    ? Math.sqrt(residuals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (residuals.length - 1))
    : 0;
  return { slopePerBar: slope, intercept, fittedLogReturn: slope * (n - 1), sigmaPerBar: sigma, points: n };
}

export type ProjectedPoint = { t: number; step: number; price: number; low68: number; high68: number; low90: number; high90: number };

export const HORIZON_STEPS = { "6M": 183, "3M": 92, "1W": 7, "1D": 24, "1H": 12, M: 15 } as const;

export function projectForward(closes: number[], intervalMs: number, steps: number, lastTime: number): {
  fit: SlopeFit;
  points: ProjectedPoint[];
  kind: "SCENARIO";
  assumptions: string[];
} {
  const fit = classifySlope(closes);
  const last = closes.filter((value) => value > 0).at(-1) ?? 1;
  const points: ProjectedPoint[] = [];
  for (let step = 0; step <= steps; step++) {
    const price = last * Math.exp(fit.slopePerBar * step);
    const sig = fit.sigmaPerBar * Math.sqrt(step);
    points.push({
      t: lastTime + step * intervalMs,
      step,
      price,
      low68: price * Math.exp(-sig),
      high68: price * Math.exp(sig),
      low90: price * Math.exp(-Z90 * sig),
      high90: price * Math.exp(Z90 * sig),
    });
  }
  return {
    fit,
    points,
    kind: "SCENARIO",
    assumptions: [
      "SCENARIO: the fitted log-price slope continues. This is not a forecast of fact.",
      "The line is anchored at the last close, then extended at the OLS slope.",
      "The band widens with sqrt(steps) using the volatility of one-step log residuals.",
      "A 15-minute decision only receives a capped fraction of this slope. It does not replace the minute tape.",
    ],
  };
}

export type TfId = "6M" | "3M" | "1W" | "1D" | "1H" | "M";

export const DEFAULT_PROJECTION_WEIGHTS: Record<TfId, number> = {
  "6M": 0.02,
  "3M": 0.03,
  "1W": 0.04,
  "1D": 0.06,
  "1H": 0.10,
  M: 0,
};

/** Max |projection log-drift| as a fraction of the decision's horizon sigma. */
export const PROJECTION_SIGMA_CAP = 0.25;

export function projectionDrift(opts: {
  frames: { id: TfId; direction: "UPHILL" | "DOWNHILL" | "FLAT" | null }[];
  sigma: number;
  weights?: Partial<Record<TfId, number>>;
  cap?: number;
}): {
  raw: number;
  applied: number;
  cap: number;
  contributions: { id: TfId; weight: number; direction: string | null; signed: number }[];
} {
  const weights = { ...DEFAULT_PROJECTION_WEIGHTS, ...opts.weights };
  const capFrac = opts.cap ?? PROJECTION_SIGMA_CAP;
  const sigma = opts.sigma > 0 ? opts.sigma : 0;
  const contributions = opts.frames.map((frame) => {
    const weight = weights[frame.id] ?? 0;
    const sign = frame.direction === "UPHILL" ? 1 : frame.direction === "DOWNHILL" ? -1 : 0;
    return { id: frame.id, weight, direction: frame.direction, signed: sign * weight * sigma };
  });
  const raw = contributions.reduce((sum, item) => sum + item.signed, 0);
  const limit = capFrac * sigma;
  const applied = Math.min(limit, Math.max(-limit, raw));
  return { raw, applied, cap: limit, contributions };
}

export type Level = { price: number; label: string; source: string };
export type Crossing = { level: number; label: string; source: string; kind: "path" | "upper90" | "lower90"; projectedTime: number };

export function roundLevels(spot: number, span: number): Level[] {
  if (!(spot > 0)) return [];
  const step = spot >= 10_000 ? 1000 : spot >= 1000 ? 100 : 10;
  const lo = Math.floor((spot - span) / step) * step;
  const hi = Math.ceil((spot + span) / step) * step;
  const out: Level[] = [];
  for (let price = lo; price <= hi && out.length < 24; price += step) {
    if (price > 0) out.push({ price, label: `Round ${price.toLocaleString("en-US")}`, source: "round" });
  }
  return out;
}

export function findCrossings(path: { t: number; price: number; low: number; high: number }[], levels: Level[]): Crossing[] {
  const out: Crossing[] = [];
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const next = path[i];
    for (const level of levels) {
      const hit = (a: number, b: number, kind: Crossing["kind"]) => {
        if ((a - level.price) === 0) {
          out.push({ ...level, level: level.price, kind, projectedTime: prev.t });
          return;
        }
        if ((a - level.price) * (b - level.price) < 0) {
          const frac = (level.price - a) / (b - a);
          out.push({ ...level, level: level.price, kind, projectedTime: prev.t + frac * (next.t - prev.t) });
        }
      };
      hit(prev.price, next.price, "path");
      hit(prev.high, next.high, "upper90");
      hit(prev.low, next.low, "lower90");
    }
  }
  return out;
}

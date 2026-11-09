/**
 * Scenarios, not promises.
 * One-minute or daily log returns supply a sample volatility. Horizon vol is that
 * vol times sqrt(time). Drift is the average return over the horizon, shrunk by 0.25
 * and capped at half a horizon sigma, plus a small bias/projection nudge capped at
 * 0.25 sigma. The 68% band is ±1 sigma and the 90% band is ±1.64485 sigma.
 */

export const Z68 = 1;
export const Z90 = 1.6448536269514722;
export const MOMENTUM_SHRINK = 0.25;
export const MOMENTUM_SIGMA_CAP = 0.5;
export const NUDGE_SIGMA_CAP = 0.25;
export const BIAS_SIGMA = 0.15;

export type Bias = "UPHILL" | "DOWNHILL" | "FLAT";

export const FIFTEEN_MINUTE_METHOD =
  "This is a scenario, not a certainty. Recent Kraken 1-minute log returns set the volatility. " +
  "Volatility to the named close is that 1-minute vol times sqrt(minutes left). " +
  "Momentum drift is the average 1-minute log return times minutes left, shrunk by 0.25 and capped at half a sigma. " +
  "Long-timeframe bias and the forward-projection nudge together move the mean by at most 0.25 sigma, " +
  "so they cannot override the minute tape or a strike that sits further away than that. " +
  "The 68% band is ±1 sigma and the 90% band is ±1.64 sigma on a lognormal sketch.";

export const SHORT_HORIZON_METHOD =
  "SCENARIO, not a forecast of fact. Daily Kraken log returns set a one-day volatility. " +
  "The 1-day, 3-day, and 7-day ranges scale that vol by sqrt(days). " +
  "Drift is the shrunk average daily return plus a long-bias and projection term, and the non-tape nudge is capped at 0.25 sigma. " +
  "Drop probabilities are the lognormal chance of finishing at least 5%, 10%, or 20% under the current price. " +
  "Nothing here is a promise, and it never places or sells a position by itself.";

export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const next = closes[i];
    if (prev > 0 && next > 0) out.push(Math.log(next / prev));
  }
  return out;
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((sum, value) => sum + value, 0) / xs.length;
}

export function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const avg = mean(xs);
  const variance = xs.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function bandPair(point: number, sigma: number, z: number): [number, number] {
  if (!(point > 0)) return [point, point];
  return [point * Math.exp(-z * sigma), point * Math.exp(z * sigma)];
}

export function bandWidth(band: [number, number]): number {
  return band[1] - band[0];
}

/** P(S_T > strike). Sigma is the horizon log-vol. */
export function probAbove(spot: number, mu: number, sigma: number, strike: number): number {
  if (!(spot > 0) || !(strike > 0)) return 0.5;
  const point = spot * Math.exp(mu);
  if (sigma <= 1e-12) {
    if (point > strike) return 1;
    if (point < strike) return 0;
    return 0.5;
  }
  return normalCdf((mu - Math.log(strike / spot)) / sigma);
}

/** P(S_T <= spot * (1 - dropFraction)). */
export function probDropAtLeast(spot: number, mu: number, sigma: number, dropFraction: number): number {
  const level = spot * (1 - dropFraction);
  if (!(spot > 0) || !(level > 0)) return 0;
  if (sigma <= 1e-12) {
    const point = spot * Math.exp(mu);
    if (point < level) return 1;
    if (point > level) return 0;
    return 0.5;
  }
  return normalCdf((Math.log(level / spot) - mu) / sigma);
}

export type Distribution = {
  mu: number;
  sigma: number;
  point: number;
  band68: [number, number];
  band90: [number, number];
  momentum: number;
  nudge: number;
};

export function distribution(spot: number, mu: number, sigma: number, momentum = 0, nudge = 0): Distribution {
  const point = spot > 0 ? spot * Math.exp(mu) : spot;
  return {
    mu,
    sigma,
    point,
    band68: bandPair(point, sigma, Z68),
    band90: bandPair(point, sigma, Z90),
    momentum,
    nudge,
  };
}

function driftParts(rawPerStep: number, steps: number, sigma: number, bias: Bias, projectionSigma: number, halveMomentum: boolean) {
  let momentum = sigma > 0 ? clamp(rawPerStep * steps * MOMENTUM_SHRINK, -MOMENTUM_SIGMA_CAP * sigma, MOMENTUM_SIGMA_CAP * sigma) : 0;
  if (halveMomentum) momentum *= 0.5;
  const biasSigma = bias === "UPHILL" ? BIAS_SIGMA : bias === "DOWNHILL" ? -BIAS_SIGMA : 0;
  const projection = clamp(projectionSigma, -NUDGE_SIGMA_CAP, NUDGE_SIGMA_CAP);
  const nudgeSigma = clamp(biasSigma + projection, -NUDGE_SIGMA_CAP, NUDGE_SIGMA_CAP);
  const nudge = nudgeSigma * sigma;
  return { momentum, nudge, mu: momentum + nudge, projectionApplied: projection * sigma, biasApplied: biasSigma * sigma };
}

export type CloseForecast = Distribution & {
  ok: true;
  minutesRemaining: number;
  probabilityAbove: number | null;
  sampleSize: number;
  sigma1m: number;
  method: string;
  timestamp: number;
  inputs: Record<string, number | string>;
};

export function forecastToClose(input: {
  spot: number;
  minuteCloses: number[];
  minutesRemaining: number;
  strike: number | null;
  now?: number;
  longBias?: Bias;
  projectionSigma?: number;
  reversalHalve?: boolean;
}): CloseForecast | { ok: false; reason: string } {
  const returns = logReturns(input.minuteCloses);
  if (returns.length < 2) return { ok: false, reason: "Not enough recent Kraken minutes to sketch a range." };
  const minutes = Math.max(0, input.minutesRemaining);
  const sigma1m = sampleStdev(returns);
  const sigma = sigma1m * Math.sqrt(minutes);
  const parts = driftParts(mean(returns), minutes, sigma, input.longBias ?? "FLAT", input.projectionSigma ?? 0, !!input.reversalHalve);
  const dist = distribution(input.spot, parts.mu, sigma, parts.momentum, parts.nudge);
  return {
    ok: true,
    ...dist,
    minutesRemaining: minutes,
    probabilityAbove: input.strike != null && input.strike > 0 ? probAbove(input.spot, parts.mu, sigma, input.strike) : null,
    sampleSize: returns.length,
    sigma1m,
    method: FIFTEEN_MINUTE_METHOD,
    timestamp: input.now ?? Date.now(),
    inputs: {
      spot: input.spot,
      minutes,
      sigma1m,
      rawMean: mean(returns),
      momentum: parts.momentum,
      nudge: parts.nudge,
      biasApplied: parts.biasApplied,
      projectionApplied: parts.projectionApplied,
      longBias: input.longBias ?? "FLAT",
    },
  };
}

export type HorizonForecast = Distribution & {
  id: "1d" | "3d" | "7d";
  days: number;
  pointReturn: number;
  lower90Return: number;
  upper90Return: number;
  pDrop5: number;
  pDrop10: number;
  pDrop20: number;
};

export type ShortScenario = {
  ok: true;
  spot: number;
  computedAt: number;
  horizons: Record<"1d" | "3d" | "7d", HorizonForecast>;
  assumptions: string[];
  method: string;
  sampleSize: number;
};

const HORIZON_DAYS = { "1d": 1, "3d": 3, "7d": 7 } as const;

export function shortHorizonScenario(input: {
  spot: number;
  dailyCloses: number[];
  now?: number;
  longBias?: Bias;
  projectionSigma?: number;
}): ShortScenario | { ok: false; reason: string } {
  const returns = logReturns(input.dailyCloses);
  if (returns.length < 10 || !(input.spot > 0)) {
    return { ok: false, reason: "Not enough daily Kraken history for a 1/3/7 day scenario." };
  }
  const sigmaDay = sampleStdev(returns);
  const raw = mean(returns);
  const now = input.now ?? Date.now();
  const horizons = {} as Record<"1d" | "3d" | "7d", HorizonForecast>;
  for (const id of ["1d", "3d", "7d"] as const) {
    const days = HORIZON_DAYS[id];
    const sigma = sigmaDay * Math.sqrt(days);
    const parts = driftParts(raw, days, sigma, input.longBias ?? "FLAT", input.projectionSigma ?? 0, false);
    const dist = distribution(input.spot, parts.mu, sigma, parts.momentum, parts.nudge);
    horizons[id] = {
      id,
      days,
      ...dist,
      pointReturn: dist.point / input.spot - 1,
      lower90Return: dist.band90[0] / input.spot - 1,
      upper90Return: dist.band90[1] / input.spot - 1,
      pDrop5: probDropAtLeast(input.spot, parts.mu, sigma, 0.05),
      pDrop10: probDropAtLeast(input.spot, parts.mu, sigma, 0.10),
      pDrop20: probDropAtLeast(input.spot, parts.mu, sigma, 0.20),
    };
  }
  return {
    ok: true,
    spot: input.spot,
    computedAt: now,
    horizons,
    sampleSize: returns.length,
    method: SHORT_HORIZON_METHOD,
    assumptions: [
      "SCENARIO: the recent daily drift and volatility continue. This is not a certainty.",
      "Volatility scales with sqrt(days). The 3-day view is the headline.",
      "Non-tape bias is capped at 0.25 horizon sigma and does not replace the daily tape.",
      "No order is created by asking for this range.",
    ],
  };
}

export const DEFAULT_SHORT_HORIZON_REFRESH_MS = 60 * 60 * 1000;

export function shouldRefresh(computedAt: number | null, now: number, refreshMs = DEFAULT_SHORT_HORIZON_REFRESH_MS, force = false): boolean {
  if (force) return true;
  if (computedAt == null) return true;
  return now - computedAt >= refreshMs;
}

export function scenarioIsStale(computedAt: number | null, now: number, staleMs = DEFAULT_SHORT_HORIZON_REFRESH_MS * 2): boolean {
  if (computedAt == null) return true;
  return now - computedAt > staleMs;
}

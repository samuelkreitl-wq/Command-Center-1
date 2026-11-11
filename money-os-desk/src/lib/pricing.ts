/**
 * Shared Money Desk math. Proposals only — nothing here sends an order.
 * Fee: ceil to the cent of multiplier × 0.07 × C × P × (1−P).
 */

export const TAKER_FEE_RATE = 0.07;
/** PASS requires at least this many cents of edge per contract after fees. */
export const MIN_EDGE_CENTS = 2;
/** PASS also requires edge of at least this fraction of the price (playbook §2.5). */
export const MIN_EDGE_PRICE_FRACTION = 0.03;
/** A quote moved this far (dollars) must be confirmed again. */
export const MATERIAL_PRICE_MOVE = 0.01;

export function takerFeeDollars(price: number, count: number, multiplier = 1): number {
  if (!(price > 0) || price >= 1 || !(count > 0) || !(multiplier >= 0)) return 0;
  const raw = multiplier * TAKER_FEE_RATE * count * price * (1 - price);
  if (!(raw > 0)) return 0;
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

export function feePerContractDollars(price: number, count: number, multiplier = 1): number {
  if (!(count > 0)) return 0;
  return takerFeeDollars(price, count, multiplier) / count;
}

/** Edge in cents per contract after the taker fee for this order size. */
export function edgeCents(fair: number, price: number, count: number, multiplier = 1): number {
  if (!Number.isFinite(fair) || !Number.isFinite(price)) return Number.NaN;
  const feeCents = feePerContractDollars(price, count, multiplier) * 100;
  return 100 * (fair - price) - feeCents;
}

export function clearsEdgeThreshold(cents: number, price: number): boolean {
  if (!Number.isFinite(cents) || !(price > 0) || price >= 1) return false;
  return cents >= MIN_EDGE_CENTS - 1e-9 && cents / 100 >= MIN_EDGE_PRICE_FRACTION * price - 1e-9;
}

/** Binary Kelly fraction f* = (p − P) / (1 − P). Zero when there is no edge. */
export function kellyFraction(fair: number, price: number): number {
  if (!(price > 0) || price >= 1 || !(fair > price) || fair > 1) return 0;
  return (fair - price) / (1 - price);
}

/**
 * Whole contracts from quarter Kelly, capped by contracts actually on the ask.
 * Returns 0 when the fraction sizes below one contract.
 */
export function quarterKellyContracts(fair: number, price: number, bankroll: number, depth: number): number {
  if (!(bankroll > 0) || !(price > 0) || !(depth > 0)) return 0;
  const dollars = 0.25 * kellyFraction(fair, price) * bankroll;
  const wanted = Math.floor(dollars / price + 1e-9);
  const fillable = Math.floor(depth + 1e-9);
  return Math.max(0, Math.min(wanted, fillable));
}

export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x < 0 ? 0 : 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * P(S_T > K) under a zero-drift lognormal. sigmaHorizon is the stdev of ln return
 * over the remaining horizon (not annualized).
 */
export function lognormalAbove(spot: number, strike: number, sigmaHorizon: number): number {
  if (!(spot > 0) || !(strike > 0)) return Number.NaN;
  if (!(sigmaHorizon > 0)) return spot > strike ? 1 : spot < strike ? 0 : 0.5;
  const z = (Math.log(spot / strike) - 0.5 * sigmaHorizon * sigmaHorizon) / sigmaHorizon;
  return normalCdf(z);
}

export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  const s = Math.sqrt(v);
  return Number.isFinite(s) ? s : null;
}

export function americanToProb(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american < 0) return -american / (-american + 100);
  return 100 / (american + 100);
}

export function decimalToProb(decimal: number): number | null {
  if (!(decimal > 1)) return null;
  return 1 / decimal;
}

/** Power-method k with sum p^k = 1, via bisection. */
export function powerDevig(probs: number[]): number[] | null {
  if (probs.length < 2 || probs.some((p) => !(p > 0) || p >= 1)) return null;
  const sum = probs.reduce((a, b) => a + b, 0);
  if (sum <= 1) return probs.map((p) => p / sum);
  let lo = 0.05;
  let hi = 8;
  const f = (k: number) => probs.reduce((a, p) => a + p ** k, 0);
  if (f(hi) > 1) return null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return probs.map((p) => p ** k);
}

export function multiplicativeDevig(probs: number[]): number[] | null {
  if (probs.length < 2 || probs.some((p) => !(p > 0))) return null;
  const sum = probs.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return probs.map((p) => p / sum);
}

/** Lower of the two no-vig methods, per outcome. That is the fair used for edge. */
export function conservativeDevig(probs: number[]): { fair: number[]; multiplicative: number[]; power: number[] } | null {
  const mult = multiplicativeDevig(probs);
  const power = powerDevig(probs);
  if (!mult || !power) return null;
  return {
    fair: mult.map((p, i) => Math.min(p, power[i])),
    multiplicative: mult,
    power,
  };
}

export function fixedPointDollars(price: number): string {
  const units = Math.round(price * 10000);
  return (units / 10000).toFixed(4);
}

export function fixedPointCount(count: number): string {
  const units = Math.round(count * 100);
  return (units / 100).toFixed(2);
}

/** YES-book price for a buy. Buying NO is an ask on YES at 1 − P. */
export function yesBookPrice(side: "YES" | "NO", price: number): string {
  const units = Math.round(price * 10000);
  if (units <= 0 || units >= 10000) throw new Error("Price must be between 0 and 1");
  const yesUnits = side === "YES" ? units : 10000 - units;
  return (yesUnits / 10000).toFixed(4);
}

export type V2OrderBody = {
  ticker: string;
  client_order_id: string;
  side: "bid" | "ask";
  count: string;
  price: string;
  time_in_force: "immediate_or_cancel";
  self_trade_prevention_type: "taker_at_cross";
  exchange_index: number;
};

export function buildV2BuyOrder(input: {
  ticker: string;
  side: "YES" | "NO";
  count: number;
  price: number;
  exchangeIndex: number;
  clientOrderId: string;
}): V2OrderBody {
  if (!Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) {
    throw new Error("exchange_index must be the market's shard");
  }
  if (!(input.count > 0) || !Number.isFinite(input.count)) throw new Error("Count must be a positive number");
  return {
    ticker: input.ticker,
    client_order_id: input.clientOrderId,
    side: input.side === "YES" ? "bid" : "ask",
    count: fixedPointCount(input.count),
    price: yesBookPrice(input.side, input.price),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    exchange_index: input.exchangeIndex,
  };
}

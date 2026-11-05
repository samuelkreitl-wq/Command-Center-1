/**
 * Indicator math for the BTC15 desk.
 * RSI(7), EMA9/21, and VWAP stay here. They cite evidence.
 * They do not choose the in-window call. That comparison is compareToStrike.
 */

import type { ContractWindow, Direction, SignalAction, SpotTick } from "./types";
import type { Agreement } from "./types";
import { compareToStrike } from "./strike-call";

export interface Bar1m {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EngineResult {
  call: Direction;
  agreement: Agreement;
  action: SignalAction;
  actionWhy: string;
  factors: string[];
  distance: number;
  minutesLeft: number;
  price: number;
}

export type IndicatorName = "RSI7" | "EMA9/21" | "VWAP" | "VOLUME";
export type IndicatorVote = "UP" | "DOWN" | "NEUTRAL";

export interface IndicatorReading {
  indicator: IndicatorName;
  vote: IndicatorVote;
  raw: Record<string, number | null>;
}

export function rsi(closes: number[], period = 7): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const ag = gains / period;
  const al = losses / period;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
  }
  return e;
}

export function vwap(bars: Bar1m[]): number | null {
  if (!bars.length) return null;
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

/** A 1m bar is closed once its minute has ended. The forming bar is left out. */
export function closedBars(bars: Bar1m[], now: number): Bar1m[] {
  return bars
    .filter((b) => Number.isFinite(b.t) && b.t + 60_000 <= now)
    .slice()
    .sort((a, b) => a.t - b.t);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function sideOf(price: number | null, level: number | null): IndicatorVote {
  if (price == null || level == null) return "NEUTRAL";
  if (price > level) return "UP";
  if (price < level) return "DOWN";
  return "NEUTRAL";
}

/**
 * Raw indicator readings. Votes are trend directions, not the BTC15 call.
 * VOLUME votes only when the last closed bar expands beyond the median and
 * its own body has a direction.
 */
export function readIndicators(
  price: number | null,
  bars: Bar1m[],
  now: number
): IndicatorReading[] {
  const closed = closedBars(bars, now);
  const closes = closed.map((b) => b.close);
  const r = rsi(closes, 7);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const vw = vwap(closed.slice(-15));

  let rsiVote: IndicatorVote = "NEUTRAL";
  if (r != null) {
    if (r >= 60) rsiVote = "UP";
    else if (r <= 40) rsiVote = "DOWN";
  }

  let emaVote: IndicatorVote = "NEUTRAL";
  if (e9 != null && e21 != null) {
    if (e9 > e21) emaVote = "UP";
    else if (e9 < e21) emaVote = "DOWN";
  }

  const last = closed.length ? closed[closed.length - 1] : null;
  const priorVolumes = closed.slice(0, -1).map((b) => b.volume);
  const med = median(priorVolumes);
  let volumeVote: IndicatorVote = "NEUTRAL";
  if (last && med != null && last.volume > med) {
    if (last.close > last.open) volumeVote = "UP";
    else if (last.close < last.open) volumeVote = "DOWN";
  }

  return [
    { indicator: "RSI7", vote: rsiVote, raw: { rsi: r } },
    { indicator: "EMA9/21", vote: emaVote, raw: { ema9: e9, ema21: e21 } },
    {
      indicator: "VWAP",
      vote: sideOf(price, vw),
      raw: { price, vwap: vw },
    },
    {
      indicator: "VOLUME",
      vote: volumeVote,
      raw: {
        lastVolume: last ? last.volume : null,
        medianVolume: med,
        barOpen: last ? last.open : null,
        barClose: last ? last.close : null,
      },
    },
  ];
}

export function leanVsLevel(price: number, level: number): Direction {
  return compareToStrike(price, level);
}

/**
 * In-window description of last vs strike.
 * Agreement is attached after the call is chosen and does not change it.
 * Returns null when there is no strike or no price. The call lifecycle,
 * not this helper, is what still emits a call in that case.
 */
export function runEngine(
  contract: ContractWindow,
  spot: SpotTick | null,
  bars: Bar1m[],
  nowMs = Date.now()
): EngineResult | null {
  if (!contract.strike || !Number.isFinite(contract.strike)) return null;
  const price = spot?.price ?? (bars.length ? bars[bars.length - 1].close : null);
  if (price == null || !Number.isFinite(price)) return null;

  const call = compareToStrike(price, contract.strike);
  const distance = price - contract.strike;
  const closeMs = new Date(contract.closeTime).getTime();
  const minutesLeft = (closeMs - nowMs) / 60_000;
  const readings = readIndicators(price, bars, nowMs);
  const factors = readings.map(
    (r) =>
      `${r.indicator} ${r.vote} ${JSON.stringify(r.raw)}`
  );
  factors.unshift(
    `Last ${price.toFixed(2)} vs strike ${contract.strike.toFixed(2)} → ${call}`
  );

  const directional = readings.filter((r) => r.vote === "UP" || r.vote === "DOWN");
  const aligned = directional.filter((r) => r.vote === call).length;
  const opposed = directional.filter((r) => r.vote !== call).length;
  const agreement: Agreement = aligned >= 2 && opposed === 0 ? "strong" : "weak";

  return {
    call,
    agreement,
    action: "WATCH",
    actionWhy: `Call is last vs strike (${call}). Agreement is ${agreement} and does not change it.`,
    factors,
    distance,
    minutesLeft,
    price,
  };
}

/**
 * Short-window directional engine (heuristic, not ML).
 * Outputs live call + confidence + book-aware action.
 * Does not lock — call lockCore separately.
 */

import type {
  ContractWindow,
  Direction,
  SignalAction,
  SpotTick,
} from "./types";

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
  confidence: number;
  action: SignalAction;
  actionWhy: string;
  factors: string[];
  distance: number;
  minutesLeft: number;
  price: number;
}

function rsi(closes: number[], period = 7): number | null {
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

function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
  }
  return e;
}

function vwap(bars: Bar1m[]): number | null {
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

export function runEngine(
  contract: ContractWindow,
  spot: SpotTick | null,
  bars: Bar1m[],
  nowMs = Date.now()
): EngineResult | null {
  if (!contract.strike || !Number.isFinite(contract.strike)) return null;
  if (!bars.length && !spot?.price) return null;

  const price = spot?.price ?? bars[bars.length - 1].close;
  const distance = price - contract.strike;
  const closeMs = new Date(contract.closeTime).getTime();
  const minutesLeft = (closeMs - nowMs) / 60_000;

  const closes = bars.map((b) => b.close);
  const factors: string[] = [];
  let score = 0;

  if (distance >= 0) {
    score += 1;
    factors.push(`Above strike by ${distance.toFixed(2)}`);
  } else {
    score -= 1;
    factors.push(`Below strike by ${Math.abs(distance).toFixed(2)}`);
  }

  const r = rsi(closes, 7);
  if (r != null) {
    if (r >= 60) {
      score += 0.5;
      factors.push(`RSI(7)=${r.toFixed(1)} firm`);
    } else if (r <= 40) {
      score -= 0.5;
      factors.push(`RSI(7)=${r.toFixed(1)} soft`);
    } else {
      factors.push(`RSI(7)=${r.toFixed(1)} neutral`);
    }
  }

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  if (e9 != null && e21 != null) {
    if (e9 > e21) {
      score += 0.75;
      factors.push("EMA9 > EMA21");
    } else if (e9 < e21) {
      score -= 0.75;
      factors.push("EMA9 < EMA21");
    }
  }

  const vw = vwap(bars.slice(-15));
  if (vw != null) {
    if (price >= vw) {
      score += 0.5;
      factors.push(`Price ≥ window VWAP (${vw.toFixed(2)})`);
    } else {
      score -= 0.5;
      factors.push(`Price < window VWAP (${vw.toFixed(2)})`);
    }
  }

  if (minutesLeft < 2 && minutesLeft > 0) {
    factors.push(`Late window (${minutesLeft.toFixed(1)}m left) — prefer NO_TRADE if edge thin`);
  }

  const call: Direction = score >= 0 ? "UP" : "DOWN";
  const magnitude = Math.min(Math.abs(score), 3);
  const confidence = Math.round(50 + magnitude * 12);

  const yesAsk = contract.yesAsk || 0;
  const noAsk =
    contract.noAsk || (yesAsk > 0 ? Math.max(0, Math.min(1, 1 - yesAsk)) : 0);
  const p = confidence / 100;

  let action: SignalAction = "WATCH";
  let actionWhy = "Edge thin versus live ask.";

  if (call === "UP" && yesAsk > 0 && yesAsk > p + 0.04) {
    action = "NO_TRADE";
    actionWhy = `YES ask ${(yesAsk * 100).toFixed(0)}¢ rich vs engine ${confidence}%`;
  } else if (call === "DOWN" && noAsk > 0 && noAsk > 1 - p + 0.04) {
    action = "NO_TRADE";
    actionWhy = `NO ask ${(noAsk * 100).toFixed(0)}¢ rich vs engine ${confidence}%`;
  } else if (call === "UP" && yesAsk > 0 && p - yesAsk >= 0.08 && confidence >= 68) {
    action = "LEAN_YES";
    actionWhy = `YES ask ${(yesAsk * 100).toFixed(0)}¢ vs engine ${confidence}%`;
  } else if (call === "DOWN" && noAsk > 0 && p - (1 - noAsk) >= 0.08 && confidence >= 68) {
    action = "LEAN_NO";
    actionWhy = `NO ask ${(noAsk * 100).toFixed(0)}¢ vs engine ${confidence}%`;
  }

  return {
    call,
    confidence,
    action,
    actionWhy,
    factors,
    distance,
    minutesLeft,
    price,
  };
}

export function leanVsLevel(price: number, level: number): Direction {
  return price >= level ? "UP" : "DOWN";
}

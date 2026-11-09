/**
 * Kalshi general taker fee, effective 2026-07-07 published schedule:
 *   fee = ceil to the next cent of (M × 0.07 × C × P × (1−P))
 * M = 1 for KXBTC15M (it is not on the special-series list).
 * Paper fills lift the ask, so they are taker fills, not the 0.0175 maker rate.
 * The numeric table is whole cents (a 50¢ contract is $0.02). There is no settlement fee.
 */

export const TAKER_FEE_RATE = 0.07;

export function takerFeeDollars(price: number, count: number, multiplier = 1): number {
  if (!(price > 0) || price >= 1 || !(count > 0) || !(multiplier >= 0)) return 0;
  const raw = multiplier * TAKER_FEE_RATE * count * price * (1 - price);
  if (!(raw > 0)) return 0;
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

export function settlementPnl(input: { side: "yes" | "no"; count: number; entry: number; entryFee: number; result: "yes" | "no" }): number {
  const won = input.side === input.result;
  const payoff = won ? input.count : 0;
  return payoff - input.count * input.entry - input.entryFee;
}

export function exitPnl(input: { count: number; entry: number; entryFee: number; exit: number; exitFee: number }): number {
  return input.count * input.exit - input.count * input.entry - input.entryFee - input.exitFee;
}

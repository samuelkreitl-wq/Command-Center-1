/**
 * Paper trades — labeled practice, never sent to Kalshi.
 * Settle vs strike (not custom ref).
 */

import type { ContractWindow, Direction, PaperTrade, TradeSide } from "./types";
import { windowId } from "./signal-lock";

function id(): string {
  return `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function openPaperTrade(opts: {
  contract: ContractWindow;
  side: TradeSide;
  size: number;
  hardStopActive: boolean;
}): PaperTrade {
  if (opts.hardStopActive) {
    throw new Error("Hard-stop active — paper size blocked");
  }
  if (opts.size <= 0) throw new Error("Size must be > 0");

  const entry =
    opts.side === "YES" ? opts.contract.yesAsk : opts.contract.noAsk;
  if (!(entry > 0 && entry < 1)) {
    throw new Error("Missing or invalid ask for paper fill");
  }

  return {
    id: id(),
    windowId: windowId(opts.contract.ticker, opts.contract.closeTime),
    ticker: opts.contract.ticker,
    market: opts.contract.market,
    mode: "paper",
    side: opts.side,
    size: opts.size,
    entry,
    strike: opts.contract.strike,
    openedAt: Date.now(),
    note: "PAPER — not sent to exchange",
  };
}

/**
 * Simple binary PnL in dollars assuming $1 max payout per contract.
 */
export function settlePaperTrade(
  trade: PaperTrade,
  endPx: number
): PaperTrade {
  if (trade.settledAt) return trade;
  const outcome: Direction = endPx >= trade.strike ? "UP" : "DOWN";
  const won =
    (trade.side === "YES" && outcome === "UP") ||
    (trade.side === "NO" && outcome === "DOWN");
  const pnl = won
    ? trade.size * (1 - trade.entry)
    : trade.size * -trade.entry;

  return {
    ...trade,
    settledAt: Date.now(),
    outcome,
    endPx,
    pnl: Math.round(pnl * 100) / 100,
  };
}

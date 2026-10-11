/**
 * Facade for Phase 1+2 desk: engine + immutable lock + paper + hard-stop.
 */

import type {
  ContractWindow,
  CoreLock,
  DeskSnapshot,
  PaperTrade,
  SpotTick,
  TradeSide,
} from "./types";
import { runEngine, leanVsLevel, type Bar1m } from "./engine";
import { lockCore, windowId } from "./signal-lock";
import {
  appendLock,
  appendTrade,
  evidenceStats,
  loadCustomRef,
  loadLocks,
  loadTrades,
  saveCustomRef,
  settleLocksForWindow,
  settleTradesForWindow,
} from "./journal";
import { openPaperTrade } from "./paper";
import { cooldownForMarket, evaluateHardStop } from "./hard-stop";

export function buildSnapshot(
  contract: ContractWindow | null,
  spot: SpotTick | null,
  bars: Bar1m[],
  now = Date.now()
): DeskSnapshot {
  const locks = loadLocks();
  const customRef = loadCustomRef();
  const hardStop = contract
    ? evaluateHardStop(locks, now, cooldownForMarket(contract.market))
    : evaluateHardStop(locks, now);

  let engine = null;
  if (contract) {
    engine = runEngine(contract, spot, bars, now);
  }

  const price = spot?.price ?? (bars.length ? bars[bars.length - 1].close : null);
  const coreLock =
    contract != null
      ? locks.find(
          (r) =>
            r.windowId === windowId(contract.ticker, contract.closeTime) &&
            !r.settledAt
        ) ??
        locks.find(
          (r) => r.windowId === windowId(contract.ticker, contract.closeTime)
        ) ??
        null
      : null;

  return {
    contract,
    spot,
    customRef,
    leanVsStrike:
      price != null && contract ? leanVsLevel(price, contract.strike) : null,
    leanVsCustom:
      price != null && customRef != null ? leanVsLevel(price, customRef) : null,
    distanceToStrike:
      price != null && contract ? price - contract.strike : null,
    distanceToCustom:
      price != null && customRef != null ? price - customRef : null,
    minutesLeft: engine?.minutesLeft ?? null,
    liveCall: engine?.call ?? null,
    confidence: engine?.confidence ?? 0,
    action: hardStop.active ? "NO_TRADE" : engine?.action ?? "WATCH",
    actionWhy: hardStop.active
      ? hardStop.reason
      : engine?.actionWhy ?? "Waiting for data",
    factors: engine?.factors ?? [],
    coreLock: coreLock ?? null,
    scalp: null,
    hardStop,
    evidence: evidenceStats(locks),
  };
}

export function lockFromLive(
  contract: ContractWindow,
  spot: SpotTick | null,
  bars: Bar1m[],
  now = Date.now()
): CoreLock | null {
  const eng = runEngine(contract, spot, bars, now);
  if (!eng) return null;
  const locks = loadLocks();
  const existing =
    locks.find(
      (r) => r.windowId === windowId(contract.ticker, contract.closeTime)
    ) ?? null;
  const locked = lockCore(existing, {
    ticker: contract.ticker,
    market: contract.market,
    closeTime: contract.closeTime,
    lockedCall: eng.call,
    confidence: eng.confidence,
    startPx: eng.price,
    strike: contract.strike,
    action: eng.action,
    factors: eng.factors,
    lockedAt: now,
  });
  appendLock(locked);
  return locked;
}

export function placePaper(
  contract: ContractWindow,
  side: TradeSide,
  size: number,
  now = Date.now()
): PaperTrade {
  const locks = loadLocks();
  const hs = evaluateHardStop(
    locks,
    now,
    cooldownForMarket(contract.market)
  );
  const trade = openPaperTrade({
    contract,
    side,
    size,
    hardStopActive: hs.active,
  });
  appendTrade(trade);
  return trade;
}

export function settleWindow(
  contract: ContractWindow,
  endPx: number
): { locks: CoreLock[]; trades: PaperTrade[] } {
  const id = windowId(contract.ticker, contract.closeTime);
  const locks = settleLocksForWindow(id, endPx, contract.strike);
  const trades = settleTradesForWindow(id, endPx);
  return { locks, trades };
}

export function setCustomReference(n: number | null): void {
  saveCustomRef(n);
}

export function listJournal(): CoreLock[] {
  return loadLocks();
}

export function listTradeLog(): PaperTrade[] {
  return loadTrades();
}

/**
 * Facade for Phase 1+2 desk: engine + immutable lock + paper + hard-stop.
 */

import type {
  ContractWindow,
  CoreLock,
  DeskSnapshot,
  Direction,
  PaperTrade,
  SpotTick,
  TradeSide,
} from "./types";
import { runEngine, leanVsLevel, callVsStrike, type Bar1m } from "./engine";
import { lockCore, windowId } from "./signal-lock";
import {
  appendLock,
  appendTrade,
  evidenceStats,
  loadCustomRef,
  loadLocks,
  loadTrades,
  replaceLock,
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
      price != null && contract?.strike != null ? leanVsLevel(price, contract.strike) : null,
    leanVsCustom:
      price != null && customRef != null ? leanVsLevel(price, customRef) : null,
    distanceToStrike:
      price != null && contract?.strike != null ? price - contract.strike : null,
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
  const close = Date.parse(contract.closeTime);
  if (!Number.isFinite(close) || close <= now) {
    throw new Error("This market window is closed");
  }
  if (!spot || !Number.isFinite(spot.price) || spot.price <= 0 ||
      now - spot.ts > 30000 || spot.ts > now + 5000) {
    throw new Error("A fresh spot price is required to lock a call");
  }
  if (contract.openTime && Date.parse(contract.openTime) <= now) {
    throw new Error("This window already opened");
  }
  if (contract.strike == null) return null;
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
    strike: contract.strike ?? 0,
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
  if (!Number.isFinite(endPx) || endPx <= 0) {
    throw new Error("Final price must be a positive finite number");
  }
  const close = Date.parse(contract.closeTime);
  if (!Number.isFinite(close) || close > Date.now()) {
    throw new Error("Wait until the window closes before manual settlement");
  }
  const id = windowId(contract.ticker, contract.closeTime);
  const locks = settleLocksForWindow(id, endPx, contract.strike ?? 0);
  const trades = settleTradesForWindow(id, endPx);
  return { locks, trades };
}

export function setCustomReference(n: number | null): void {
  if (n !== null && (!Number.isFinite(n) || n <= 0)) {
    throw new Error("Reference price must be a positive finite number");
  }
  saveCustomRef(n);
}

export function listJournal(): CoreLock[] {
  return loadLocks();
}

export function listTradeLog(): PaperTrade[] {
  return loadTrades();
}

export function isFreshSpotTick(spot: SpotTick | null, now: number): spot is SpotTick {
  return !!spot && Number.isFinite(spot.price) && spot.price > 0 &&
    now - spot.ts <= 30_000 && spot.ts <= now + 5_000;
}

/** Desk poll interval. "Immediately" means the first poll that sees a posted strike and a fresh spot. */
export const DESK_POLL_MS = 8000;
/** No call is committed at or after open + 5:00. */
export const CALL_DEADLINE_MS = 5 * 60 * 1000;
/** Minute 10 starts at open+10:00. */
export const CHANGE_MARK_MS = 10 * 60 * 1000;
/** The one change is allowed for the whole of minute 10: [open+10:00, open+11:00). */
export const CHANGE_WINDOW_MS = 60 * 1000;

export function tenMinuteTick(openTime: string | undefined): { start: number; end: number } | null {
  if (!openTime) return null;
  const open = Date.parse(openTime);
  if (!Number.isFinite(open)) return null;
  const start = open + CHANGE_MARK_MS;
  return { start, end: start + CHANGE_WINDOW_MS };
}

/**
 * Official floor_strike only. No guessed strike.
 * Before that strike posts, the row is awaiting: "no call" and no strike number.
 * A call is committed on the poll where the desk was already watching, the official
 * strike is present, the spot is fresh, and now is still before open+5:00.
 * At open+5:00 with no call, the row becomes MISSED and is never back-filled.
 * A window first seen with a strike already posted is MISSED (the desk was not running).
 * Markets with no openTime are left for the manual lock.
 */
export function maintainWindows(input: {
  active: ContractWindow | null;
  upcoming: ContractWindow | null;
  spot: SpotTick | null;
  bars?: Bar1m[];
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  closeExpiredWatches(now);
  const markets = [input.active, input.upcoming].filter((m): m is ContractWindow => m != null);
  for (const market of markets) {
    if (!market.openTime) continue;
    const open = Date.parse(market.openTime);
    const close = Date.parse(market.closeTime);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    const id = windowId(market.ticker, market.closeTime);
    const existing = loadLocks().find((r) => r.windowId === id) ?? null;
    if (existing?.missed || existing?.lockedCall) continue;
    const strike = officialStrike(market.strike);
    const deadline = open + CALL_DEADLINE_MS;
    if (now >= deadline) {
      if (!existing) appendLock(missedRecord(market, strike, input.spot, now, "deadline"));
      else if (existing.awaitingStrike) replaceLock(missedRecord(market, strike, input.spot, now, "deadline"));
      continue;
    }
    if (strike == null) {
      if (!existing) appendLock(awaitingRecord(market, now));
      continue;
    }
    if (existing?.awaitingStrike) {
      const spot = input.spot;
      if (!isFreshSpotTick(spot, now)) continue;
      replaceLock(lockAgainstOfficial(market, strike, spot, input.bars ?? [], now));
      continue;
    }
    if (!existing) appendLock(missedRecord(market, strike, input.spot, now, "not watching"));
  }
}

/**
 * One change, any time during minute 10 [open+10:00, open+11:00).
 * A second change is stored as a refusal. From open+11:00 the call is locked.
 * A stale spot never applies a change and does not use up the one change.
 */
export function reviseLockedCall(
  id: string,
  newCall: Direction,
  reason: string,
  now = Date.now(),
  spot: SpotTick | null = null
): CoreLock {
  const row = loadLocks().find((r) => r.windowId === id);
  if (!row || row.missed || row.lockedCall == null) {
    throw new Error("No locked call to change");
  }
  const tick = tenMinuteTick(row.openTime);
  const close = Date.parse(row.closeTime);
  if (tick == null) throw new Error("A change needs a known open time");
  if (!Number.isFinite(close) || now >= close) throw new Error("The window is closed");
  const text = reason.trim();
  if (!text) throw new Error("A change requires a reason");
  if (row.revisionRefusal) throw new Error("A second change was already refused");
  if (now < tick.start) throw new Error("A change is only allowed during minute 10");
  if (now >= tick.end) {
    replaceLock({
      ...row,
      revisionRefusal: { at: now, attempted: newCall, reason: text },
    });
    throw new Error("The call is locked from open+11:00");
  }
  if (!isFreshSpotTick(spot, now)) throw new Error("A stale spot cannot change a call");
  if (row.revision) {
    replaceLock({
      ...row,
      revisionRefusal: { at: now, attempted: newCall, reason: text },
    });
    throw new Error("A second change is refused");
  }
  const effective = row.revisedCall ?? row.lockedCall;
  if (newCall === effective) throw new Error("That is already the call");
  const updated: CoreLock = {
    ...row,
    revisedCall: newCall,
    revision: { at: now, from: row.lockedCall, to: newCall, reason: text },
  };
  replaceLock(updated);
  return updated;
}

function closeExpiredWatches(now: number): void {
  for (const row of loadLocks()) {
    if (!row.awaitingStrike || row.missed || row.lockedCall || !row.openTime) continue;
    const open = Date.parse(row.openTime);
    if (!Number.isFinite(open) || now < open + CALL_DEADLINE_MS) continue;
    replaceLock(missedRecord(
      {
        ticker: row.ticker,
        series: "KXBTC15M",
        market: row.market,
        strike: row.strike,
        closeTime: row.closeTime,
        openTime: row.openTime,
        yesAsk: 0,
        noAsk: 0,
      },
      officialStrike(row.strike),
      null,
      now,
      "deadline"
    ));
  }
}

function officialStrike(strike: number | null): number | null {
  return strike != null && Number.isFinite(strike) && strike > 0 ? strike : null;
}

function awaitingRecord(market: ContractWindow, now: number): CoreLock {
  return {
    windowId: windowId(market.ticker, market.closeTime),
    ticker: market.ticker,
    market: market.market,
    lockedCall: null,
    awaitingStrike: true,
    confidence: 0,
    lockedAt: now,
    startPx: 0,
    strike: null,
    closeTime: market.closeTime,
    openTime: market.openTime,
    action: "WATCH",
    factors: ["No official floor_strike yet"],
  };
}

function lockAgainstOfficial(
  market: ContractWindow,
  strike: number,
  spot: SpotTick,
  bars: Bar1m[],
  now: number
): CoreLock {
  const priced: ContractWindow = { ...market, strike };
  const eng = runEngine(priced, spot, bars, now);
  return {
    windowId: windowId(market.ticker, market.closeTime),
    ticker: market.ticker,
    market: market.market,
    lockedCall: callVsStrike(spot.price, strike),
    awaitingStrike: false,
    confidence: eng?.confidence ?? 62,
    lockedAt: now,
    startPx: spot.price,
    strike,
    closeTime: market.closeTime,
    openTime: market.openTime,
    action: eng?.action ?? "WATCH",
    factors: eng?.factors ?? [`Official strike ${strike}`],
  };
}

function missedRecord(
  market: ContractWindow,
  strike: number | null,
  spot: SpotTick | null,
  now: number,
  why: "not watching" | "deadline"
): CoreLock {
  return {
    windowId: windowId(market.ticker, market.closeTime),
    ticker: market.ticker,
    market: market.market,
    lockedCall: null,
    awaitingStrike: false,
    missed: true,
    confidence: 0,
    lockedAt: now,
    startPx: spot?.price ?? 0,
    strike,
    closeTime: market.closeTime,
    openTime: market.openTime,
    action: "NO_TRADE",
    factors: [
      why === "deadline"
        ? "MISSED: no call committed by open+5:00"
        : "MISSED: the desk was not running when this window's strike was posted",
    ],
  };
}


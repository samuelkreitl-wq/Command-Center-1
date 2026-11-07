/**
 * Facade for Phase 1+2 desk: engine + immutable lock + paper + hard-stop.
 */

import type {
  ContractWindow,
  CoreLock,
  DeskSnapshot,
  Direction,
  ExpectedStrikeSource,
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

/**
 * Pre-window strike, in order:
 * 1. This window's own posted floor_strike, when Kalshi has published it.
 * 2. The other open 15m market's floor_strike (the latest known pin).
 * 3. The newest settled end price in the journal.
 * 4. The fresh Kraken last, rounded to the cent.
 * Comparing spot to (4) locks AT STRIKE. That is deliberate: there is no
 * independent level yet, and the call is still made before the open.
 */
export function chooseExpectedStrike(input: {
  ownStrike: number | null;
  openMarketStrike: number | null;
  priorSettle: number | null;
  spot: number | null;
}): { price: number; source: ExpectedStrikeSource } | null {
  const posted = positive(input.ownStrike);
  if (posted != null) return { price: roundCent(posted), source: "posted-strike" };
  const open = positive(input.openMarketStrike);
  if (open != null) return { price: roundCent(open), source: "open-market" };
  const prior = positive(input.priorSettle);
  if (prior != null) return { price: roundCent(prior), source: "prior-settle" };
  const spot = positive(input.spot);
  if (spot != null) return { price: roundCent(spot), source: "spot" };
  return null;
}

export function isFreshSpotTick(spot: SpotTick | null, now: number): spot is SpotTick {
  return !!spot && Number.isFinite(spot.price) && spot.price > 0 &&
    now - spot.ts <= 30_000 && spot.ts <= now + 5_000;
}

export function halfwayAt(row: { openTime?: string; closeTime: string }): number | null {
  if (!row.openTime) return null;
  const open = Date.parse(row.openTime);
  const close = Date.parse(row.closeTime);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) return null;
  return open + (close - open) / 2;
}

/**
 * Lock the next window before it opens, record a later official strike beside
 * that call, and mark a window that already opened with no prior lock as MISSED.
 * Markets with no openTime are left alone so a manual lock can still be taken.
 */
export function maintainWindows(input: {
  active: ContractWindow | null;
  upcoming: ContractWindow | null;
  spot: SpotTick | null;
  bars?: Bar1m[];
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const markets = [input.active, input.upcoming].filter((m): m is ContractWindow => m != null);
  for (const market of markets) {
    if (!market.openTime) continue;
    const open = Date.parse(market.openTime);
    const close = Date.parse(market.closeTime);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    const id = windowId(market.ticker, market.closeTime);
    const existing = loadLocks().find((r) => r.windowId === id) ?? null;
    if (open > now) {
      if (!existing) {
        const spot = input.spot;
        if (!isFreshSpotTick(spot, now)) continue;
        const created = buildPreWindowLock(market, input.active, spot, input.bars ?? [], now);
        if (created) appendLock(created);
      } else if (!existing.missed && existing.lockedCall) {
        noteOfficialStrike(existing, market.strike);
      }
      continue;
    }
    const lockedBeforeOpen = !!existing && !existing.missed && existing.lockedCall != null && existing.lockedAt < open;
    if (lockedBeforeOpen && existing) {
      noteOfficialStrike(existing, market.strike);
      continue;
    }
    if (!existing) appendLock(missedRecord(market, input.spot, now));
  }
}

/** One optional change, only at or after halfway. A second attempt is stored as a refusal. */
export function reviseLockedCall(
  id: string,
  newCall: Direction,
  reason: string,
  now = Date.now()
): CoreLock {
  const row = loadLocks().find((r) => r.windowId === id);
  if (!row || row.missed || row.lockedCall == null) {
    throw new Error("No locked call to change");
  }
  const half = halfwayAt(row);
  const close = Date.parse(row.closeTime);
  if (half == null) throw new Error("A change needs a known open time");
  if (now < half) throw new Error("A change is only allowed at or after the halfway mark");
  if (!Number.isFinite(close) || now >= close) throw new Error("The window is closed");
  const text = reason.trim();
  if (!text) throw new Error("A change requires a reason");
  if (row.revisionRefusal) throw new Error("A second change was already refused");
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

function buildPreWindowLock(
  market: ContractWindow,
  active: ContractWindow | null,
  spot: SpotTick,
  bars: Bar1m[],
  now: number
): CoreLock | null {
  const otherStrike = active && active.ticker !== market.ticker ? active.strike : null;
  const prior = latestSettledPrice(loadLocks());
  const ref = chooseExpectedStrike({
    ownStrike: market.strike,
    openMarketStrike: otherStrike,
    priorSettle: prior,
    spot: spot.price,
  });
  if (!ref) return null;
  const synthetic: ContractWindow = { ...market, strike: ref.price };
  const eng = runEngine(synthetic, spot, bars, now);
  const lockedCall = callVsStrike(spot.price, ref.price);
  return {
    windowId: windowId(market.ticker, market.closeTime),
    ticker: market.ticker,
    market: market.market,
    lockedCall,
    confidence: ref.source === "spot" ? 50 : eng?.confidence ?? 62,
    lockedAt: now,
    startPx: spot.price,
    strike: ref.price,
    closeTime: market.closeTime,
    openTime: market.openTime,
    action: eng?.action ?? "WATCH",
    factors: [
      `Expected strike ${ref.price.toFixed(2)} via ${ref.source}`,
      ...(eng?.factors ?? []),
    ],
    officialStrike: market.strike != null && market.strike > 0 ? market.strike : undefined,
    expectedStrikeSource: ref.source,
  };
}

function noteOfficialStrike(existing: CoreLock, strike: number | null): void {
  if (strike == null || !(strike > 0) || existing.officialStrike === strike) return;
  replaceLock({ ...existing, officialStrike: strike });
}

function missedRecord(market: ContractWindow, spot: SpotTick | null, now: number): CoreLock {
  return {
    windowId: windowId(market.ticker, market.closeTime),
    ticker: market.ticker,
    market: market.market,
    lockedCall: null,
    missed: true,
    confidence: 0,
    lockedAt: now,
    startPx: spot?.price ?? 0,
    strike: market.strike != null && market.strike > 0 ? market.strike : 0,
    closeTime: market.closeTime,
    openTime: market.openTime,
    action: "NO_TRADE",
    factors: ["MISSED: no call was locked before this window opened"],
  };
}

function latestSettledPrice(locks: CoreLock[]): number | null {
  const settled = locks
    .filter((r) => !r.missed && r.endPx != null && r.endPx > 0)
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
  return settled[0]?.endPx ?? null;
}

function positive(n: number | null): number | null {
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}


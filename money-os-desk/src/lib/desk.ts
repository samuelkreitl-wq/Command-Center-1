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
import {
  createCallLedger,
  findWindowCall,
  type CallLedger,
} from "./call-ledger";
import {
  CallLifecycleError,
  assessQuality,
  lockInitialCall,
  worstQuality,
  type Btc15CallInput,
} from "./call-lifecycle";
import { WINDOW_MS } from "./strike-call";

let sharedLedger: CallLedger | null = null;

export function btc15Ledger(): CallLedger {
  if (!sharedLedger) sharedLedger = createCallLedger();
  return sharedLedger;
}

function currentDataQuality(
  contract: ContractWindow,
  spot: SpotTick | null,
  bars: Bar1m[],
  now: number
) {
  const quote =
    spot && spot.source === "kraken" && Number.isFinite(spot.price) && spot.price > 0
      ? { price: spot.price, ts: spot.ts, source: "kraken" as const }
      : null;
  const strike = contract.strike > 0 ? contract.strike : null;
  const closeMs = Date.parse(contract.closeTime);
  const parts = assessQuality(
    {
      ticker: contract.ticker,
      openTime: Number.isFinite(closeMs)
        ? new Date(closeMs - WINDOW_MS).toISOString()
        : contract.closeTime,
      closeTime: contract.closeTime,
      floorStrike: strike,
      spot: quote,
      bars,
      now,
    },
    quote?.ts ?? null,
    quote?.price ?? null,
    strike
  );
  return worstQuality([parts.quote, parts.strike, parts.clock, parts.bars]);
}

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

  const locked = contract
    ? findWindowCall(btc15Ledger(), contract.ticker, contract.closeTime)
    : null;
  const inForce = locked?.revision ?? locked?.initial ?? null;
  const unlockedQuality = !inForce && contract
    ? currentDataQuality(contract, spot, bars, now)
    : null;

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
    liveCall: locked?.finalCall ?? null,
    agreement: inForce?.agreement ?? null,
    dataQuality: inForce?.quality ?? unlockedQuality,
    action: hardStop.active ? "NO_TRADE" : engine?.action ?? "WATCH",
    actionWhy: hardStop.active
      ? hardStop.reason
      : locked
        ? inForce?.why ?? "Locked call"
        : "BTC15 call is not locked yet",
    factors: inForce
      ? inForce.evidence.map(
          (e) => `${e.indicator} ${e.role} ${JSON.stringify(e.raw)}`
        )
      : engine?.factors ?? [],
    coreLock: coreLock ?? null,
    scalp: null,
    hardStop,
    evidence: evidenceStats(locks),
  };
}

/**
 * Legacy journal mirror of a 15m pre-start lock.
 * The authoritative record is the append-only call ledger.
 * At or after the window open this does not create a call.
 */
export function lockFromLive(
  contract: ContractWindow,
  spot: SpotTick | null,
  bars: Bar1m[],
  now = Date.now()
): CoreLock | null {
  const locks = loadLocks();
  const existing =
    locks.find(
      (r) => r.windowId === windowId(contract.ticker, contract.closeTime)
    ) ?? null;

  if (contract.market === "15m") {
    const closeMs = Date.parse(contract.closeTime);
    if (!Number.isFinite(closeMs)) return existing;
    const openMs = closeMs - WINDOW_MS;
    const input: Btc15CallInput = {
      ticker: contract.ticker,
      openTime: new Date(openMs).toISOString(),
      closeTime: contract.closeTime,
      floorStrike: contract.strike,
      spot:
        spot && spot.source === "kraken" && Number.isFinite(spot.price)
          ? { price: spot.price, ts: spot.ts, source: "kraken" }
          : null,
      bars,
      now,
    };
    try {
      const state = lockInitialCall(btc15Ledger(), input);
      const view = lockCore(existing, {
        ticker: contract.ticker,
        market: contract.market,
        closeTime: contract.closeTime,
        lockedCall: state.initial.call,
        confidence: 0,
        startPx: state.initial.price ?? 0,
        strike: contract.strike,
        action: "WATCH",
        factors: [state.initial.why],
        lockedAt: state.initial.at,
      });
      appendLock(view);
      return view;
    } catch (error) {
      if (
        error instanceof CallLifecycleError &&
        error.code === "TOO_LATE_TO_LOCK"
      ) {
        return existing;
      }
      throw error;
    }
  }

  const eng = runEngine(contract, spot, bars, now);
  if (!eng) return null;
  const locked = lockCore(existing, {
    ticker: contract.ticker,
    market: contract.market,
    closeTime: contract.closeTime,
    lockedCall: eng.call,
    confidence: 0,
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

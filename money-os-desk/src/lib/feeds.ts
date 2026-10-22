/**
 * Live feed orchestrator: Kalshi contract + Kraken spot/OHLC + Fear & Greed → desk snapshot.
 */

import type {
  ContractWindow,
  DeskSnapshot,
  MarketWindow,
  FearGreedSnapshot,
  SpotTick,
} from "./types";
import type { Bar1m } from "./engine";
import { pollKraken } from "./kraken";
import {
  enrichContractQuotes,
  fetchActiveContract,
  fetchListed15mWindows,
  type Btc15ListedWindow,
} from "./kalshi";
import { buildSnapshot } from "./desk";
import { fetchFearGreed } from "./fear-greed";
import type { CallLedger } from "./call-ledger";
import {
  advanceBtc15Calls,
  type Btc15CallInput,
  type CycleAction,
} from "./call-lifecycle";

export interface FeedBundle {
  contract: ContractWindow | null;
  spot: SpotTick | null;
  bars: Bar1m[];
  snapshot: DeskSnapshot;
  fearGreed: FearGreedSnapshot | null;
  errors: string[];
  polledAt: number;
}

export async function pollDeskFeeds(
  market: MarketWindow = "15m"
): Promise<FeedBundle> {
  const errors: string[] = [];
  let contract: ContractWindow | null = null;
  let spot: SpotTick | null = null;
  let bars: Bar1m[] = [];
  let fearGreed: FearGreedSnapshot | null = null;

  const results = await Promise.allSettled([
    fetchActiveContract(market),
    pollKraken(),
    fetchFearGreed(),
  ]);

  if (results[0].status === "fulfilled") {
    contract = results[0].value;
    if (contract) {
      try {
        contract = await enrichContractQuotes(contract);
      } catch (e) {
        errors.push(`orderbook: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    errors.push(
      `kalshi: ${results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason)}`
    );
  }

  if (results[1].status === "fulfilled") {
    spot = results[1].value.spot;
    bars = results[1].value.bars;
  } else {
    errors.push(
      `kraken: ${results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)}`
    );
  }

  if (results[2].status === "fulfilled") {
    fearGreed = results[2].value;
    if (fearGreed.error) errors.push(`fearGreed: ${fearGreed.error}`);
  } else {
    errors.push(
      `fearGreed: ${results[2].reason instanceof Error ? results[2].reason.message : String(results[2].reason)}`
    );
  }

  const snapshot = buildSnapshot(contract, spot, bars);
  snapshot.fearGreed = fearGreed;

  return {
    contract,
    spot,
    bars,
    snapshot,
    fearGreed,
    errors,
    polledAt: Date.now(),
  };
}

export function startFeedLoop(
  onTick: (bundle: FeedBundle) => void,
  opts?: { market?: MarketWindow; intervalMs?: number }
): () => void {
  const market = opts?.market ?? "15m";
  const intervalMs = opts?.intervalMs ?? 8000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const bundle = await pollDeskFeeds(market);
      if (!stopped) onTick(bundle);
    } catch (e) {
      if (!stopped) {
        onTick({
          contract: null,
          spot: null,
          bars: [],
          snapshot: buildSnapshot(null, null, []),
          fearGreed: null,
          errors: [e instanceof Error ? e.message : String(e)],
          polledAt: Date.now(),
        });
      }
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function listedWindowToCallInput(
  window: Btc15ListedWindow,
  spot: SpotTick | null,
  bars: Bar1m[],
  now: number
): Btc15CallInput {
  return {
    ticker: window.ticker,
    openTime: window.openTime,
    closeTime: window.closeTime,
    floorStrike: window.floorStrike,
    expirationValue: window.expirationValue,
    spot:
      spot && spot.source === "kraken" && Number.isFinite(spot.price) && spot.price > 0
        ? { price: spot.price, ts: spot.ts, source: "kraken" }
        : null,
    bars,
    now,
  };
}

function mergeListed(windows: Btc15ListedWindow[]): Btc15ListedWindow[] {
  const byKey = new Map<string, Btc15ListedWindow>();
  for (const window of windows) {
    const key = `${window.ticker}::${window.openTime}::${window.closeTime}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...window });
      continue;
    }
    byKey.set(key, {
      ...prev,
      floorStrike: window.floorStrike ?? prev.floorStrike,
      expirationValue: window.expirationValue ?? prev.expirationValue,
      strikeType: window.strikeType ?? prev.strikeType,
      yesSubTitle: window.yesSubTitle || prev.yesSubTitle,
      status: window.expirationValue != null ? window.status : prev.status,
    });
  }
  return [...byKey.values()];
}

function settledReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * One read-only pass: public Kraken and Kalshi GETs, then the next-window
 * cycle. Fetches never place orders. A missing floor_strike stays null.
 * Duplicate rows keep a published strike and expiration when one copy has them.
 */
export async function advanceListedBtc15(
  ledger: CallLedger,
  now = Date.now()
): Promise<{ actions: CycleAction[]; errors: string[] }> {
  const errors: string[] = [];
  let spot: SpotTick | null = null;
  let bars: Bar1m[] = [];
  const windows: Btc15ListedWindow[] = [];

  const results = await Promise.allSettled([
    pollKraken(),
    fetchListed15mWindows("unopened"),
    fetchListed15mWindows("open"),
    fetchListed15mWindows("settled"),
  ]);

  if (results[0].status === "fulfilled") {
    spot = results[0].value.spot;
    bars = results[0].value.bars;
  } else {
    errors.push(`kraken: ${settledReason(results[0].reason)}`);
  }
  const lists: Array<[string, PromiseSettledResult<Btc15ListedWindow[]>]> = [
    ["kalshi unopened", results[1]],
    ["kalshi open", results[2]],
    ["kalshi settled", results[3]],
  ];
  for (const [label, result] of lists) {
    if (result.status === "fulfilled") windows.push(...result.value);
    else errors.push(`${label}: ${settledReason(result.reason)}`);
  }

  const inputs = mergeListed(windows).map((window) =>
    listedWindowToCallInput(window, spot, bars, now)
  );
  let actions: CycleAction[] = [];
  try {
    actions = advanceBtc15Calls(ledger, inputs);
  } catch (error) {
    errors.push(`cycle: ${settledReason(error)}`);
  }
  return { actions, errors };
}

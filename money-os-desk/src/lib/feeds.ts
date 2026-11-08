/**
 * Live feed orchestrator: Kalshi contract + Kraken spot/OHLC → desk snapshot.
 */

import type { ContractWindow, DeskSnapshot, MarketWindow } from "./types";
import type { Bar1m } from "./engine";
import type { SpotTick } from "./types";
import { pollKraken } from "./kraken";
import { enrichContractQuotes, fetchActiveContract, fetchNext15mContract } from "./kalshi";
import { DESK_POLL_MS, buildSnapshot, maintainWindows } from "./desk";

export { DESK_POLL_MS };

export interface FeedBundle {
  contract: ContractWindow | null;
  upcoming: ContractWindow | null;
  spot: SpotTick | null;
  bars: Bar1m[];
  snapshot: DeskSnapshot;
  errors: string[];
  polledAt: number;
}

export async function pollDeskFeeds(
  market: MarketWindow = "15m"
): Promise<FeedBundle> {
  const errors: string[] = [];
  let contract: ContractWindow | null = null;
  let upcoming: ContractWindow | null = null;
  let spot: SpotTick | null = null;
  let bars: Bar1m[] = [];

  const results = await Promise.allSettled([
    fetchActiveContract(market),
    pollKraken(),
    market === "15m" ? fetchNext15mContract() : Promise.resolve(null),
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
    upcoming = results[2].value;
  } else {
    errors.push(
      `kalshi-next: ${results[2].reason instanceof Error ? results[2].reason.message : String(results[2].reason)}`
    );
  }

  try {
    maintainWindows({ active: contract, upcoming, spot, bars });
  } catch (e) {
    errors.push(`windows: ${e instanceof Error ? e.message : String(e)}`);
  }

  const snapshot = buildSnapshot(contract, spot, bars);
  return {
    contract,
    upcoming,
    spot,
    bars,
    snapshot,
    errors,
    polledAt: Date.now(),
  };
}

export function startFeedLoop(
  onTick: (bundle: FeedBundle) => void,
  opts?: { market?: MarketWindow; intervalMs?: number }
): () => void {
  const market = opts?.market ?? "15m";
  const intervalMs = opts?.intervalMs ?? DESK_POLL_MS;
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
          upcoming: null,
          spot: null,
          bars: [],
          snapshot: buildSnapshot(null, null, []),
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


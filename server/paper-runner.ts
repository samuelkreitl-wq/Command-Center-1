/**
 * Paper runner. It reads public data and writes the paper book.
 * It does not sign requests and it does not import the live executor.
 */

import { advancePaper, type FrameReading, type PaperDecision, type PaperRow, type Watch } from "../money-os-desk/src/lib/paper-book";
import { forecastToClose } from "../money-os-desk/src/lib/forecast";
import { adjustForecast, conflictPatterns } from "../money-os-desk/src/lib/learning";
import { evaluateTimeframes, type FrameSnapshot } from "../money-os-desk/src/lib/timeframe";
import { projectionDrift } from "../money-os-desk/src/lib/projection";
import { fetchCloses, fetchKrakenLast, fetchMarkets } from "./public-data";
import type { SpotTick } from "../money-os-desk/src/lib/types";

export async function runPaperOnce(deps: {
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  now: number;
  rows: PaperRow[];
  watches: Record<string, Watch>;
  lastPollAt: number | null;
  safety?: "none" | "watch" | "danger";
}): Promise<{ rows: PaperRow[]; watches: Record<string, Watch>; lastPollAt: number; feed: "LIVE" | "STALE"; spot: number | null }> {
  let markets;
  let spot: number | null = null;
  let minuteCloses: number[] = [];
  let frames: FrameSnapshot[] = [];
  let path: "aligned" | "conflict" = "aligned";
  const safety: PaperDecision["safety"] = deps.safety ?? "none";
  try {
    const [open, unopened, settled, last, minutes] = await Promise.all([
      fetchMarkets(deps.fetchImpl, deps.env, "KXBTC15M", "open"),
      fetchMarkets(deps.fetchImpl, deps.env, "KXBTC15M", "unopened").catch(() => []),
      fetchMarkets(deps.fetchImpl, deps.env, "KXBTC15M", "settled").catch(() => []),
      fetchKrakenLast(deps.fetchImpl, deps.env),
      fetchCloses(deps.fetchImpl, deps.env, 1),
    ]);
    markets = [...open, ...unopened, ...settled];
    spot = last;
    minuteCloses = minutes;
    const tape = await evaluateTimeframes({
      now: deps.now,
      cache: {},
      load: async (id) => ({ closes: id === "M" || id === "1H" ? minutes : await fetchCloses(deps.fetchImpl, deps.env, id === "1D" ? 60 : 1440) }),
    });
    frames = tape.frames;
    path = tape.path;
  } catch {
    return { rows: [], watches: deps.watches, lastPollAt: deps.lastPollAt ?? deps.now, feed: "STALE", spot };
  }
  const spotTick: SpotTick | null = spot ? { price: spot, ts: deps.now, source: "kraken" } : null;
  const drift = projectionDrift({ sigma: 0.01, frames: frames.map((frame) => ({ id: frame.id, direction: frame.direction })) });
  const stepped = advancePaper({
    rows: deps.rows,
    watches: deps.watches,
    lastPollAt: deps.lastPollAt,
    now: deps.now,
    markets: (markets ?? []).map((market) => ({
      ticker: market.ticker,
      openTime: market.openTime,
      closeTime: market.closeTime,
      strike: market.floorStrike,
      status: market.status,
      result: market.result,
      expirationValue: market.expirationValue,
      yesBid: market.yesBid,
      yesAsk: market.yesAsk,
      noBid: market.noBid,
      noAsk: market.noAsk,
    })),
    spot: spotTick,
    decisionFor: (market) => {
      const forecast = forecastToClose({
        spot: spot ?? 0,
        minuteCloses,
        minutesRemaining: Math.max(0, (Date.parse(market.closeTime) - deps.now) / 60_000),
        strike: market.strike,
        now: deps.now,
        longBias: frames.filter((frame) => frame.direction === "UPHILL").length >= frames.filter((frame) => frame.direction === "DOWNHILL").length ? "UPHILL" : "DOWNHILL",
        projectionSigma: drift.applied / 0.01,
      });
      if (!forecast.ok || forecast.probabilityAbove == null) return null;
      const tape = frames.map((frame) => ({ id: frame.id, direction: frame.direction, stale: frame.stale, known: frame.direction != null && !frame.stale }));
      const learned = decidePaperSide({ probabilityAbove: forecast.probabilityAbove, frames: tape, rows: deps.rows });
      if (!learned.side || learned.adjusted == null) return null;
      const side = learned.side;
      const ask = side === "yes" ? market.yesAsk : market.noAsk;
      const bid = side === "yes" ? market.yesBid : market.noBid;
      return {
        side,
        count: 1,
        bid: bid || null,
        ask: ask || null,
        path,
        frames: tape,
        conflicts: conflictPatterns(tape),
        projection: drift,
        forecast: { ...forecast, adjustedProbabilityAbove: learned.adjusted, adjustmentReason: learned.reason },
        safety,
      } satisfies PaperDecision;
    },
  });
  return { ...stepped, feed: spot ? "LIVE" : "STALE", spot };
}

/** The paper book trades the adjusted scenario. No history leaves the raw probability in place. */
export function decidePaperSide(input: {
  probabilityAbove: number | null;
  frames: FrameReading[];
  rows: PaperRow[];
}): { side: "yes" | "no" | null; raw: number | null; adjusted: number | null; reason: string; applied: boolean } {
  if (input.probabilityAbove == null || !Number.isFinite(input.probabilityAbove)) {
    return { side: null, raw: null, adjusted: null, reason: "No probability.", applied: false };
  }
  const adjusted = adjustForecast({ probabilityAbove: input.probabilityAbove, frames: input.frames, history: input.rows });
  const side = adjusted.adjusted > 0.5 ? "yes" : adjusted.adjusted < 0.5 ? "no" : null;
  return { side, raw: adjusted.raw, adjusted: adjusted.adjusted, reason: adjusted.reason, applied: adjusted.applied };
}

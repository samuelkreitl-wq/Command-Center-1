/**
 * One manually recorded Kalshi result. It is not a paper-generated fill.
 * Seeding appends it only when its ids are absent.
 */

import { zonedTimeToUtc } from "./et-time";
import { settlementPnl, takerFeeDollars } from "./kalshi-fees";
import type { FrameReading, PaperEntry, PaperRow, PaperSettlement } from "./paper-book";

export const RECORDED_TICKER = "KXBTCD-26NOV0902-T74299.99";
export const RECORDED_ENTRY_ID = "recorded-kxbtcd-26nov0902-yes";
export const RECORDED_SETTLE_ID = "recorded-kxbtcd-26nov0902-settle";
export const RECORDED_STRIKE = 74299.99;
export const RECORDED_SETTLEMENT = 74216.51;

const FRAME_IDS = ["6M", "3M", "1W", "1D", "1H", "M"] as const;

function unknownFrames(): FrameReading[] {
  return FRAME_IDS.map((id) => ({
    id,
    direction: null,
    stale: true,
    known: false,
    reconstructed: true,
  }));
}

export function recordedTradeRows(): PaperRow[] {
  const close = zonedTimeToUtc(2026, 11, 9, 2, 0);
  const open = zonedTimeToUtc(2026, 11, 9, 1, 0);
  const entryTs = zonedTimeToUtc(2026, 11, 9, 1, 30);
  const entryPrice = 0.77;
  const fees = takerFeeDollars(entryPrice, 1);
  const below = RECORDED_STRIKE - RECORDED_SETTLEMENT;
  const note = `Manually recorded real Kalshi entry, not paper-generated. YES at 77 cents on hourly BTC '$74,300 or above'. Forecast about 77% YES. LOST. Kalshi settled at $${RECORDED_SETTLEMENT.toFixed(2)}, $${below.toFixed(2)} below the ${RECORDED_STRIKE} strike. Timeframe and conflict readings were not stored; they are reconstructed as unknown and still count in overall calibration.`;
  const entry: PaperEntry = {
    kind: "entry",
    id: RECORDED_ENTRY_ID,
    ts: entryTs.getTime(),
    ticker: RECORDED_TICKER,
    openTime: open.toISOString(),
    closeTime: close.toISOString(),
    direction: "UP",
    side: "yes",
    strike: RECORDED_STRIKE,
    entry: entryPrice,
    bid: null,
    ask: entryPrice,
    spread: null,
    contracts: 1,
    fees,
    path: "aligned",
    frames: unknownFrames(),
    conflicts: [
      { id: "long_vs_minute", pattern: "unknown", known: false, reconstructed: true },
      { id: "long_vs_hour", pattern: "unknown", known: false, reconstructed: true },
    ],
    projection: null,
    forecast: {
      probabilityAbove: 0.77,
      method: "Manually recorded. The live read was about 77% YES. Timeframes were not captured.",
    },
    forecastProbability: 0.77,
    safety: "none",
    lockCall: "UP",
    proposalId: RECORDED_ENTRY_ID,
    source: "recorded",
    reconstructed: true,
    title: "Kalshi hourly BTC '$74,300 or above'",
    note,
    stop: null,
  };
  const settlement: PaperSettlement = {
    kind: "settlement",
    id: RECORDED_SETTLE_ID,
    ts: close.getTime(),
    ticker: RECORDED_TICKER,
    entryId: RECORDED_ENTRY_ID,
    result: "no",
    settlementPrice: 0,
    fees: 0,
    pnl: settlementPnl({ side: "yes", count: 1, entry: entryPrice, entryFee: fees, result: "no" }),
    correct: false,
    expirationValue: RECORDED_SETTLEMENT.toFixed(2),
    source: "recorded",
    note,
  };
  return [entry, settlement];
}

export function missingRecordedRows(rows: PaperRow[]): PaperRow[] {
  const ids = new Set(rows.map((row) => row.id));
  return recordedTradeRows().filter((row) => !ids.has(row.id));
}

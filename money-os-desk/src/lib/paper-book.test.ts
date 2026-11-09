import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advancePaper, computeStats, openPositions, type MarketSnap, type PaperDecision, type PaperRow, type Watch } from "./paper-book";
import { settlementPnl, takerFeeDollars } from "./kalshi-fees";
import type { SpotTick } from "./types";

function spot(price: number, now: number): SpotTick {
  return { price, ts: now, source: "kraken" };
}

function market(ticker: string, open: number, strike: number | null, extra: Partial<MarketSnap> = {}): MarketSnap {
  return {
    ticker,
    openTime: new Date(open).toISOString(),
    closeTime: new Date(open + 15 * 60_000).toISOString(),
    strike,
    status: "active",
    yesBid: 0.4,
    yesAsk: 0.45,
    noBid: 0.5,
    noAsk: 0.55,
    ...extra,
  };
}

const decision = (side: "yes" | "no" | null = "yes"): PaperDecision => ({
  side,
  count: 1,
  bid: side === "no" ? 0.5 : 0.4,
  ask: side === "no" ? 0.55 : 0.45,
  path: "aligned",
  frames: [{ id: "6M", direction: "UPHILL", stale: false }],
  projection: { applied: 0.001 },
  forecast: { probabilityAbove: 0.62, point: 74500 },
  safety: "none",
});

test("taker fee matches the published cent table", () => {
  assert.equal(takerFeeDollars(0.5, 1), 0.02);
  assert.equal(takerFeeDollars(0.2, 1), 0.02);
  assert.equal(takerFeeDollars(0.01, 1), 0.01);
  assert.equal(takerFeeDollars(0.5, 100), 1.75);
});

test("settlement P&L subtracts the taker fee and finalized yes pays the contract", () => {
  const fee = takerFeeDollars(0.4, 1);
  assert.equal(fee, 0.02);
  assert.equal(settlementPnl({ side: "yes", count: 1, entry: 0.4, entryFee: fee, result: "yes" }), 0.58);
  assert.ok(Math.abs(settlementPnl({ side: "yes", count: 1, entry: 0.4, entryFee: fee, result: "no" }) + 0.42) < 1e-9);
});

test("one paper position per window, and the next window is separate", () => {
  const open = Date.parse("2026-11-09T06:00:00.000Z");
  let rows: PaperRow[] = [];
  let watches: Record<string, Watch> = {};
  const first = advancePaper({
    rows, watches, lastPollAt: null, now: open - 60_000,
    markets: [market("KXBTC15M-26NOV090115-15", open, null)],
    spot: spot(101, open - 60_000),
    decisionFor: () => decision(),
  });
  rows = [...rows, ...first.rows];
  watches = first.watches;
  assert.equal(rows.some((row) => row.kind === "entry"), false);
  const second = advancePaper({
    rows, watches, lastPollAt: first.lastPollAt, now: open + 60_000,
    markets: [market("KXBTC15M-26NOV090115-15", open, 100)],
    spot: spot(101, open + 60_000),
    decisionFor: () => decision(),
  });
  rows = [...rows, ...second.rows];
  watches = second.watches;
  assert.equal(rows.filter((row) => row.kind === "entry").length, 1);
  const third = advancePaper({
    rows, watches, lastPollAt: second.lastPollAt, now: open + 90_000,
    markets: [market("KXBTC15M-26NOV090115-15", open, 100), market("KXBTC15M-26NOV090130-30", open + 15 * 60_000, null)],
    spot: spot(101, open + 90_000),
    decisionFor: () => decision(),
  });
  rows = [...rows, ...third.rows];
  assert.equal(rows.filter((row) => row.kind === "entry" && row.ticker.endsWith("0115-15")).length, 1);
  const fourth = advancePaper({
    rows, watches: third.watches, lastPollAt: third.lastPollAt, now: open + 15 * 60_000 + 30_000,
    markets: [market("KXBTC15M-26NOV090130-30", open + 15 * 60_000, 100)],
    spot: spot(101, open + 15 * 60_000 + 30_000),
    decisionFor: () => decision(),
  });
  assert.equal(fourth.rows.some((row) => row.kind === "entry" && row.ticker.endsWith("0130-30")), true);
  const held = openPositions([...rows, ...fourth.rows]);
  assert.equal(held["KXBTC15M-26NOV090115-15"]?.side, "yes");
  assert.equal(held["KXBTC15M-26NOV090130-30"]?.side, "yes");
});

test("a strike already posted when the trader first sees the window is MISSED", () => {
  const open = Date.parse("2026-11-09T06:00:00.000Z");
  const result = advancePaper({
    rows: [], watches: {}, lastPollAt: null, now: open + 60_000,
    markets: [market("KXBTC15M-26NOV090115-15", open, 100)],
    spot: spot(101, open + 60_000),
    decisionFor: () => decision(),
  });
  assert.equal(result.rows.some((row) => row.kind === "missed"), true);
  assert.equal(result.rows.some((row) => row.kind === "entry"), false);
});

test("a window watched before the strike can be traded, and a second fill is refused by the open position", () => {
  const open = Date.parse("2026-11-09T06:00:00.000Z");
  const ticker = "KXBTC15M-26NOV090115-15";
  let rows: PaperRow[] = [];
  const seen = advancePaper({
    rows, watches: {}, lastPollAt: null, now: open - 30_000,
    markets: [market(ticker, open, null)],
    spot: spot(101, open - 30_000),
    decisionFor: () => decision(),
  });
  rows = seen.rows;
  const locked = advancePaper({
    rows, watches: seen.watches, lastPollAt: seen.lastPollAt, now: open + 30_000,
    markets: [market(ticker, open, 100)],
    spot: spot(101, open + 30_000),
    decisionFor: () => decision(),
  });
  rows = [...rows, ...locked.rows];
  assert.equal(openPositions(rows)[ticker]?.side, "yes");
  const again = advancePaper({
    rows, watches: locked.watches, lastPollAt: locked.lastPollAt, now: open + 40_000,
    markets: [market(ticker, open, 100)],
    spot: spot(101, open + 40_000),
    decisionFor: () => decision(),
  });
  assert.equal(again.rows.some((row) => row.kind === "entry"), false);
});

test("finalized settlement uses the Kalshi result and the fee-aware P&L", () => {
  const open = Date.parse("2026-11-09T06:00:00.000Z");
  const ticker = "KXBTC15M-26NOV090115-15";
  const seen = advancePaper({
    rows: [], watches: {}, lastPollAt: null, now: open - 30_000,
    markets: [market(ticker, open, null)], spot: spot(101, open - 30_000), decisionFor: () => decision(),
  });
  const locked = advancePaper({
    rows: seen.rows, watches: seen.watches, lastPollAt: seen.lastPollAt, now: open + 30_000,
    markets: [market(ticker, open, 100)], spot: spot(101, open + 30_000), decisionFor: () => decision(),
  });
  const rows = [...seen.rows, ...locked.rows];
  const settled = advancePaper({
    rows, watches: locked.watches, lastPollAt: locked.lastPollAt, now: open + 16 * 60_000,
    markets: [market(ticker, open, 100, { status: "finalized", result: "yes" })],
    spot: spot(101, open + 16 * 60_000),
    decisionFor: () => decision(),
  });
  const settlement = settled.rows.find((row) => row.kind === "settlement");
  assert.ok(settlement && settlement.kind === "settlement");
  if (settlement && settlement.kind === "settlement") {
    assert.equal(settlement.correct, true);
    assert.equal(settlement.fees, 0);
    assert.equal(settlement.pnl, 1 - 0.45 - takerFeeDollars(0.45, 1));
  }
  assert.equal(Object.keys(openPositions([...rows, ...settled.rows])).length, 0);
});

test("minute-10 flip closes and replaces a single position", () => {
  const open = Date.parse("2026-11-09T06:00:00.000Z");
  const ticker = "KXBTC15M-26NOV090115-15";
  const seen = advancePaper({
    rows: [], watches: {}, lastPollAt: null, now: open - 30_000,
    markets: [market(ticker, open, null)], spot: spot(101, open - 30_000), decisionFor: () => decision(),
  });
  const locked = advancePaper({
    rows: seen.rows, watches: seen.watches, lastPollAt: seen.lastPollAt, now: open + 30_000,
    markets: [market(ticker, open, 100)], spot: spot(101, open + 30_000), decisionFor: () => decision(),
  });
  const rows = [...seen.rows, ...locked.rows];
  const tick = open + 10 * 60_000 + 1000;
  const flipped = advancePaper({
    rows, watches: locked.watches, lastPollAt: locked.lastPollAt, now: tick,
    markets: [market(ticker, open, 100)], spot: spot(99, tick), decisionFor: () => decision("no"),
  });
  assert.equal(flipped.rows.some((row) => row.kind === "exit"), true);
  assert.equal(flipped.rows.filter((row) => row.kind === "entry").length, 1);
  const held = openPositions([...rows, ...flipped.rows]);
  assert.equal(held[ticker]?.side, "no");
  const second = advancePaper({
    rows: [...rows, ...flipped.rows], watches: flipped.watches, lastPollAt: flipped.lastPollAt, now: tick + 1000,
    markets: [market(ticker, open, 100)], spot: spot(101, tick + 1000), decisionFor: () => decision(),
  });
  assert.equal(second.rows.some((row) => row.kind === "refusal"), true);
  assert.equal(openPositions([...rows, ...flipped.rows, ...second.rows])[ticker]?.side, "no");
});

test("stats use settlements for win rate and streaks", () => {
  const rows: PaperRow[] = [
    { kind: "entry", id: "e1", ts: Date.parse("2026-11-09T15:00:00.000Z"), ticker: "A", openTime: "", closeTime: "", direction: "UP", side: "yes", strike: 1, entry: 0.4, bid: 0.39, ask: 0.4, spread: 0.01, contracts: 1, fees: 0.02, path: "aligned", frames: [{ id: "6M", direction: "UPHILL", stale: false }], projection: { applied: 0 }, forecast: { probabilityAbove: 0.62 }, safety: "none", lockCall: "UP", proposalId: "paper_e1" },
    { kind: "settlement", id: "s1", ts: Date.parse("2026-11-09T15:15:00.000Z"), ticker: "A", entryId: "e1", result: "yes", settlementPrice: 1, fees: 0, pnl: 0.58, correct: true },
    { kind: "entry", id: "e2", ts: Date.parse("2026-11-09T16:00:00.000Z"), ticker: "B", openTime: "", closeTime: "", direction: "DOWN", side: "no", strike: 1, entry: 0.4, bid: 0.39, ask: 0.4, spread: 0.01, contracts: 1, fees: 0.02, path: "conflict", frames: [{ id: "6M", direction: "DOWNHILL", stale: false }], projection: null, forecast: { probabilityAbove: 0.2 }, safety: "watch", lockCall: "DOWN", proposalId: "paper_e2" },
    { kind: "settlement", id: "s2", ts: Date.parse("2026-11-09T16:15:00.000Z"), ticker: "B", entryId: "e2", result: "yes", settlementPrice: 0, fees: 0, pnl: -0.42, correct: false },
  ];
  const stats = computeStats(rows);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 0.5);
  assert.ok(Math.abs(stats.totalPnl - 0.16) < 1e-9);
  assert.equal(stats.currentStreak.kind, "loss");
  assert.equal(stats.longestWinStreak, 1);
  assert.ok(stats.byAlignment.some((row) => row.key.includes("aligned")));
  assert.ok(stats.byHour.length >= 1);
  assert.ok(stats.calibration.some((bucket) => bucket.n > 0));
  assert.equal(stats.perDay.length, 1);
});

test("paper module has no live order path", () => {
  const book = readFileSync(new URL("./paper-book.ts", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../../../server/paper-runner.ts", import.meta.url), "utf8");
  for (const src of [book, runner]) {
    assert.equal(/live-executor|kalshi-sign|portfolio\/orders/.test(src), false);
  }
});

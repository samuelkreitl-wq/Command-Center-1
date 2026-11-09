import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustForecast, conflictPatterns, hitWeight, learningStats } from "./learning";
import { computeStats, type FrameReading, type PaperEntry, type PaperRow, type PaperSettlement } from "./paper-book";
import { RECORDED_SETTLEMENT, RECORDED_STRIKE, recordedTradeRows, missingRecordedRows } from "./recorded-trade";
import { etDateKey, formatEt } from "./et-time";
import { decidePaperSide } from "../../../server/paper-runner";

function frame(id: string, direction: string | null, known = true): FrameReading {
  return { id, direction, stale: !known, known };
}

function entry(id: string, frames: FrameReading[], conflicts = conflictPatterns(frames), correct = true): PaperRow[] {
  const opened: PaperEntry = {
    kind: "entry",
    id,
    ts: 1_000,
    ticker: id,
    openTime: "",
    closeTime: "",
    direction: "UP",
    side: "yes",
    strike: 1,
    entry: 0.6,
    bid: 0.59,
    ask: 0.6,
    spread: 0.01,
    contracts: 1,
    fees: 0.02,
    path: "conflict",
    frames,
    conflicts,
    projection: null,
    forecast: { probabilityAbove: 0.7 },
    forecastProbability: 0.7,
    safety: "none",
    lockCall: "UP",
    proposalId: id,
    source: "paper",
  };
  const settlement: PaperSettlement = {
    kind: "settlement",
    id: `${id}-s`,
    ts: 2_000,
    ticker: id,
    entryId: id,
    result: correct ? "yes" : "no",
    settlementPrice: correct ? 1 : 0,
    fees: 0,
    pnl: correct ? 0.3 : -0.7,
    correct,
  };
  return [opened, settlement];
}

const up = [frame("6M", "UPHILL"), frame("3M", "UPHILL"), frame("1W", "UPHILL"), frame("1D", "UPHILL"), frame("1H", "UPHILL"), frame("M", "UPHILL")];
const conflict = [frame("6M", "UPHILL"), frame("3M", "UPHILL"), frame("1W", "UPHILL"), frame("1D", "UPHILL"), frame("1H", "FLAT"), frame("M", "DOWNHILL")];

test("accuracy is tracked per timeframe and conflict pattern, with smoothing and a minimum sample", () => {
  assert.equal(conflictPatterns(conflict)[0].pattern, "long-term up / minute down");
  assert.equal(hitWeight(1, 1).smoothed, 2 / 3);
  assert.equal(hitWeight(1, 1).trusted, false);
  assert.equal(hitWeight(1, 1).weight, 1);
  assert.equal(hitWeight(0, 0).weight, 1);
  assert.equal(hitWeight(4, 4).trusted, false);
  assert.equal(hitWeight(5, 5).trusted, true);
  assert.ok(hitWeight(5, 5).weight > 1);
  assert.ok(hitWeight(5, 5).weight <= 1.25);
  assert.ok(hitWeight(0, 5).weight < 1);
  assert.ok(hitWeight(0, 5).weight >= 0.75);
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => entry(`up-${i}`, up, conflictPatterns(up), true)).flat(),
    ...Array.from({ length: 5 }, (_, i) => entry(`bad-${i}`, conflict, conflictPatterns(conflict), false)).flat(),
  ];
  const stats = learningStats(rows);
  const six = stats.byTimeframe.find((row) => row.key === "6M");
  assert.equal(six?.n, 10);
  assert.equal(six?.hits, 5);
  const minute = stats.byTimeframe.find((row) => row.key === "M");
  assert.equal(minute?.n, 10);
  const pattern = stats.byPattern.find((row) => row.key === "long-term up / minute down");
  assert.equal(pattern?.n, 5);
  assert.equal(pattern?.hits, 0);
  assert.equal(pattern?.trusted, true);
  assert.ok((pattern?.smoothed ?? 1) < 0.5);
});

test("forecasts move toward accurate patterns, away from wrong ones, and stay inside the cap", () => {
  const good = Array.from({ length: 8 }, (_, i) => entry(`g-${i}`, up, [], true)).flat();
  const toward = adjustForecast({ probabilityAbove: 0.6, frames: up, history: good });
  assert.ok(toward.adjusted > toward.raw);
  assert.ok(toward.adjusted - toward.raw <= 0.08 + 1e-12);
  assert.ok(toward.adjusted <= 0.98);
  const bad = Array.from({ length: 8 }, (_, i) => entry(`b-${i}`, up, [], false)).flat();
  const away = adjustForecast({ probabilityAbove: 0.7, frames: up, history: bad });
  assert.ok(away.adjusted < away.raw);
  assert.ok(away.raw - away.adjusted <= 0.08 + 1e-12);
  assert.ok(away.adjusted >= 0.02);
  const none = adjustForecast({ probabilityAbove: 0.64, frames: up, history: [] });
  assert.equal(none.adjusted, none.raw);
  assert.equal(none.applied, false);
  const unknown = [frame("6M", null, false), frame("3M", null, false), frame("1W", null, false), frame("1D", null, false), frame("1H", null, false), frame("M", null, false)];
  const patternRows = Array.from({ length: 6 }, (_, i) => entry(`p-${i}`, unknown, [{ id: "long_vs_minute", pattern: "long-term up / minute down", known: true }], false)).flat();
  const faded = adjustForecast({ probabilityAbove: 0.62, frames: conflict, history: patternRows });
  assert.ok(faded.adjusted < faded.raw);
  const helped = adjustForecast({
    probabilityAbove: 0.58,
    frames: conflict,
    history: Array.from({ length: 6 }, (_, i) => entry(`h-${i}`, unknown, [{ id: "long_vs_minute", pattern: "long-term up / minute down", known: true }], true)).flat(),
  });
  assert.ok(helped.adjusted > helped.raw);
});

test("the seeded loss is counted, stays idempotent, and does not swing the forecast", () => {
  const rows = recordedTradeRows();
  assert.ok(Math.abs(RECORDED_STRIKE - RECORDED_SETTLEMENT - 83.48) < 1e-6);
  const opened = rows.find((row) => row.kind === "entry");
  const settled = rows.find((row) => row.kind === "settlement");
  assert.ok(opened && opened.kind === "entry");
  assert.equal(opened.source, "recorded");
  assert.equal(opened.reconstructed, true);
  assert.equal(opened.forecastProbability, 0.77);
  assert.ok(opened.frames.every((item) => item.known === false && item.reconstructed === true));
  assert.equal(etDateKey(new Date(opened.ts)), "2026-11-09");
  assert.match(formatEt(new Date(settled && settled.kind === "settlement" ? settled.ts : 0)), /2:00 AM ET/);
  assert.equal(missingRecordedRows(rows).length, 0);
  assert.equal(missingRecordedRows([]).length, 2);
  assert.equal(missingRecordedRows([opened]).length, 1);
  const paper = computeStats(rows);
  assert.equal(paper.losses, 1);
  assert.equal(paper.settled, 1);
  assert.equal(paper.winRate, 0);
  const learning = learningStats(rows);
  assert.equal(learning.overall.n, 1);
  assert.equal(learning.overall.hits, 0);
  assert.equal(learning.recorded, 1);
  assert.ok(learning.byTimeframe.every((row) => row.n === 0));
  assert.ok(learning.byPattern.every((row) => row.n === 0));
  const adjusted = adjustForecast({ probabilityAbove: 0.66, frames: up, history: rows });
  assert.equal(adjusted.adjusted, adjusted.raw);
  const side = decidePaperSide({ probabilityAbove: 0.53, frames: conflict, rows: [] });
  assert.equal(side.side, "yes");
  const faded = decidePaperSide({
    probabilityAbove: 0.53,
    frames: conflict,
    rows: Array.from({ length: 6 }, (_, i) => entry(`s-${i}`, unknownFrames(), [{ id: "long_vs_minute", pattern: "long-term up / minute down", known: true }], false)).flat(),
  });
  assert.equal(faded.side, "no");
  assert.ok((faded.adjusted ?? 1) < 0.53);
  assert.ok(0.53 - (faded.adjusted ?? 0) <= 0.08 + 1e-12);
});

function unknownFrames(): FrameReading[] {
  return ["6M", "3M", "1W", "1D", "1H", "M"].map((id) => frame(id, null, false));
}

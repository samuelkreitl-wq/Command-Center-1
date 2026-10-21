import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, lockFromLive, placePaper, settleWindow, setCustomReference } from "./desk";
import { loadLocks, loadTrades } from "./journal";
import { openPaperTrade, settlePaperTrade } from "./paper";
import { mapMarketToContract, fetchOrderbookAsks } from "./kalshi";
import type { ContractWindow } from "./types";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
});
beforeEach(() => store.clear());
const contract = (): ContractWindow => ({
  ticker: "TEST-BTC", series: "KXBTC15M", market: "15m",
  strike: 80000, closeTime: new Date(Date.now() + 60000).toISOString(),
  yesAsk: 0.4, noAsk: 0.65,
});

test("first core call remains immutable and persists across snapshots", () => {
  const c = contract();
  const first = lockFromLive(c, { price: 80100, ts: Date.now(), source: "manual" }, []);
  const second = lockFromLive(c, { price: 79900, ts: Date.now(), source: "manual" }, []);
  assert.equal(first?.lockedCall, "UP");
  assert.deepEqual(second, first);
  assert.equal(loadLocks().length, 1);
  assert.equal(buildSnapshot(c, null, []).coreLock?.lockedCall, "UP");
});

test("paper orders persist, reject invalid sizes and never execute live", () => {
  const c = contract();
  const trade = placePaper(c, "YES", 3);
  assert.equal(trade.mode, "paper");
  assert.equal(loadTrades().length, 1);
  for (const size of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => placePaper(c, "YES", size), /positive whole/);
  }
  assert.throws(() => placePaper({ ...c, yesAsk: 0 }, "YES", 1), /ask/);
});

test("closed windows and stale spot cannot create new calls or trades", () => {
  const c = { ...contract(), closeTime: new Date(Date.now() - 1000).toISOString() };
  assert.throws(() => placePaper(c, "YES", 1), /closed/);
  assert.throws(() => lockFromLive(c, { price: 80000, ts: Date.now(), source: "manual" }, []), /closed/);
  assert.throws(() => lockFromLive(contract(), { price: 80000, ts: Date.now() - 31000, source: "manual" }, []), /fresh/);
});

test("manual settlement waits for expiry; a missed lock triggers hard-stop", () => {
  const now = Date.now();
  const c = { ...contract(), closeTime: new Date(now - 1000).toISOString() };
  lockFromLive(c, { price: 80100, ts: now - 2000, source: "manual" }, [], now - 2000);
  assert.throws(() => settleWindow(contract(), 79900), /Wait/);
  settleWindow(c, 79900);
  const snap = buildSnapshot(contract(), null, []);
  assert.equal(snap.hardStop.active, true);
  assert.equal(snap.action, "NO_TRADE");
  assert.throws(() => placePaper(contract(), "YES", 1), /Hard-stop/);
  assert.equal(snap.evidence.settled, 1);
});

test("paper PnL uses strike, includes equality and settles once", () => {
  const trade = openPaperTrade({ contract: contract(), side: "YES", size: 5, hardStopActive: false });
  const settled = settlePaperTrade(trade, 80000);
  assert.equal(settled.outcome, "UP");
  assert.equal(settled.pnl, 3);
  assert.deepEqual(settlePaperTrade(settled, 70000), settled);
  assert.throws(() => settlePaperTrade(trade, NaN), /finite/);
});

test("reference is persisted and cannot be invalid", () => {
  setCustomReference(81000);
  assert.equal(buildSnapshot(null, null, []).customRef, 81000);
  assert.throws(() => setCustomReference(Infinity), /finite/);
  setCustomReference(null);
  assert.equal(buildSnapshot(null, null, []).customRef, null);
});

test("market mapping preserves public dollar quotes and ignores missing strike", () => {
  const raw = { ticker: "BTC", event_ticker: "BTC", status: "active", close_time: contract().closeTime,
    floor_strike: 80000, yes_ask_dollars: "0.4200", no_ask_dollars: "0.5900" };
  assert.equal(mapMarketToContract(raw, "15m")?.yesAsk, 0.42);
  assert.equal(mapMarketToContract({ ...raw, floor_strike: undefined }, "15m"), null);
});

test("orderbook asks are derived from opposite-side bids", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    orderbook_fp: { yes_dollars: [["0.40", "5"], ["0.45", "2"]], no_dollars: [["0.52", "3"]] },
  }));
  try {
    assert.deepEqual(await fetchOrderbookAsks("BTC"), { yesAsk: 0.48, noAsk: 0.55 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

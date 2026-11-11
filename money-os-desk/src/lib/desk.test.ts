import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, lockFromLive, placePaper, settleWindow, setCustomReference } from "./desk";
import { loadLocks, loadTrades } from "./journal";
import { openPaperTrade, settlePaperTrade } from "./paper";
import { mapMarketToContract, mapScheduledMarket, fetchOrderbookAsks } from "./kalshi";
import { CHANGE_WINDOW_MS, maintainWindows, reviseLockedCall, tenMinuteTick } from "./desk";
import type { ContractWindow, SpotTick } from "./types";

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

test("price exactly at the strike is AT STRIKE; above is UP and below is DOWN", () => {
  const c = contract();
  assert.equal(lockFromLive(c, { price: 80000, ts: Date.now(), source: "manual" }, [])?.lockedCall, "AT STRIKE");
  const up = { ...c, ticker: "UP", closeTime: new Date(Date.now() + 120000).toISOString() };
  const down = { ...c, ticker: "DOWN", closeTime: new Date(Date.now() + 180000).toISOString() };
  assert.equal(lockFromLive(up, { price: 80000.01, ts: Date.now(), source: "manual" }, [])?.lockedCall, "UP");
  assert.equal(lockFromLive(down, { price: 79999.99, ts: Date.now(), source: "manual" }, [])?.lockedCall, "DOWN");
});

test("no official strike is no call; the posted strike locks immediately, including AT STRIKE", () => {
  const now = Date.now();
  const spot = { price: 80100, ts: now, source: "manual" as const };
  const active: ContractWindow = {
    ...contract(), ticker: "OPEN-NOW", strike: 79000,
    openTime: new Date(now - 60_000).toISOString(),
    closeTime: new Date(now + 14 * 60_000).toISOString(),
  };
  const upcoming: ContractWindow = {
    ticker: "NEXT", series: "KXBTC15M", market: "15m", strike: null,
    openTime: new Date(now + 5 * 60_000).toISOString(),
    closeTime: new Date(now + 20 * 60_000).toISOString(),
    yesAsk: 0, noAsk: 0,
  };
  maintainWindows({ active, upcoming, spot, now });
  const next = loadLocks().find((row) => row.ticker === "NEXT");
  assert.equal(next?.awaitingStrike, true);
  assert.equal(next?.lockedCall, null);
  assert.equal(next?.strike, null);
  assert.equal(loadLocks().find((row) => row.ticker === "OPEN-NOW")?.missed, true);
  assert.equal(loadLocks().find((row) => row.ticker === "OPEN-NOW")?.lockedCall, null);
  const exact: ContractWindow = {
    ticker: "EXACT", series: "KXBTC15M", market: "15m", strike: null,
    openTime: new Date(now + 40 * 60_000).toISOString(),
    closeTime: new Date(now + 55 * 60_000).toISOString(),
    yesAsk: 0, noAsk: 0,
  };
  maintainWindows({ active: null, upcoming: exact, spot, now });
  assert.equal(loadLocks().find((row) => row.ticker === "EXACT")?.lockedCall, null);
  maintainWindows({ active: null, upcoming: { ...exact, strike: 80100 }, spot, now });
  const at = loadLocks().find((row) => row.ticker === "EXACT");
  assert.equal(at?.lockedCall, "AT STRIKE");
  assert.equal(at?.strike, 80100);
  maintainWindows({ active, upcoming: { ...upcoming, strike: 80000 }, spot, now });
  const posted = loadLocks().find((row) => row.ticker === "NEXT");
  assert.equal(posted?.lockedCall, "UP");
  assert.equal(posted?.strike, 80000);
  assert.equal(posted?.awaitingStrike, false);
  const bare = mapScheduledMarket({
    ticker: "BARE", event_ticker: "BARE", status: "initialized",
    close_time: upcoming.closeTime, open_time: upcoming.openTime,
  }, "15m");
  assert.equal(bare?.strike, null);
});

const MINUTE_10_OPEN = Date.parse("2026-11-07T00:00:00.000Z");

function freshSpot(at: number, price = 79900): SpotTick {
  return { price, ts: at, source: "manual" };
}

/** Watch the window with no strike, then commit on the poll that posts floor_strike. */
function commitOnPostedStrike(ticker: string, openMs = MINUTE_10_OPEN): string {
  const open = new Date(openMs).toISOString();
  const close = new Date(openMs + 15 * 60_000).toISOString();
  const waiting: ContractWindow = {
    ticker, series: "KXBTC15M", market: "15m", strike: null,
    openTime: open, closeTime: close, yesAsk: 0.4, noAsk: 0.6,
  };
  const seenAt = openMs + 30_000;
  maintainWindows({
    active: null, upcoming: waiting,
    spot: { price: 80100, ts: seenAt, source: "manual" }, now: seenAt,
  });
  assert.equal(loadLocks().find((row) => row.ticker === ticker)?.lockedCall, null);
  const postedAt = openMs + 60_000;
  maintainWindows({
    active: null,
    upcoming: { ...waiting, strike: 80000 },
    spot: { price: 80100, ts: postedAt, source: "manual" },
    now: postedAt,
  });
  const locked = loadLocks().find((row) => row.ticker === ticker);
  assert.equal(locked?.lockedCall, "UP");
  assert.equal(locked?.strike, 80000);
  assert.equal(locked?.awaitingStrike, false);
  return locked!.windowId;
}

test("minute 10 is the whole minute [open+10:00, open+11:00)", () => {
  const open = new Date(MINUTE_10_OPEN).toISOString();
  const tick = tenMinuteTick(open);
  assert.equal(tick?.start, MINUTE_10_OPEN + 10 * 60_000);
  assert.equal(tick?.end, MINUTE_10_OPEN + 11 * 60_000);
  assert.equal(tick!.end - tick!.start, CHANGE_WINDOW_MS);
  assert.equal(tenMinuteTick(undefined), null);
});

test("one change is allowed at 10:00, 10:30, and 10:59.9, and refused at 11:00", () => {
  const id = commitOnPostedStrike("HALF");
  const start = MINUTE_10_OPEN + 10 * 60_000;
  assert.throws(
    () => reviseLockedCall(id, "DOWN", "too early", start - 1, freshSpot(start - 1)),
    /during minute 10/,
  );
  assert.equal(loadLocks().find((row) => row.windowId === id)?.revision, undefined);
  assert.equal(loadLocks().find((row) => row.windowId === id)?.revisionRefusal, undefined);

  const cases = [
    { ticker: "AT-1000", at: start, reason: "at 10:00" },
    { ticker: "AT-1030", at: start + 30_000, reason: "at 10:30" },
    { ticker: "AT-1059", at: start + 59_900, reason: "at 10:59.9" },
  ];
  for (const sample of cases) {
    const windowId = commitOnPostedStrike(sample.ticker);
    const changed = reviseLockedCall(windowId, "DOWN", sample.reason, sample.at, freshSpot(sample.at));
    assert.equal(changed.lockedCall, "UP");
    assert.equal(changed.revisedCall, "DOWN");
    assert.equal(changed.revision?.from, "UP");
    assert.equal(changed.revision?.to, "DOWN");
    assert.equal(changed.revision?.reason, sample.reason);
    assert.equal(changed.revision?.at, sample.at);
    assert.equal(changed.revisionRefusal, undefined);
  }

  const lateId = commitOnPostedStrike("AT-1100");
  const lockedAt = start + CHANGE_WINDOW_MS;
  assert.equal(lockedAt, MINUTE_10_OPEN + 11 * 60_000);
  assert.throws(
    () => reviseLockedCall(lateId, "DOWN", "at 11:00", lockedAt, freshSpot(lockedAt)),
    /locked from open\+11:00/,
  );
  const late = loadLocks().find((row) => row.windowId === lateId);
  assert.equal(late?.lockedCall, "UP");
  assert.equal(late?.revisedCall, undefined);
  assert.equal(late?.revision, undefined);
  assert.equal(late?.revisionRefusal?.attempted, "DOWN");
  assert.equal(late?.revisionRefusal?.reason, "at 11:00");
  assert.equal(late?.revisionRefusal?.at, lockedAt);
  assert.throws(
    () => reviseLockedCall(lateId, "AT STRIKE", "later still", lockedAt + 5_000, freshSpot(lockedAt + 5_000)),
    /already refused/,
  );
  assert.equal(loadLocks().find((row) => row.windowId === lateId)?.revisionRefusal?.reason, "at 11:00");
});

test("a second change during minute 10 is refused and stays refused", () => {
  const id = commitOnPostedStrike("SECOND");
  const start = MINUTE_10_OPEN + 10 * 60_000;
  const changed = reviseLockedCall(id, "DOWN", "spot flipped", start, freshSpot(start));
  assert.equal(changed.revisedCall, "DOWN");
  assert.equal(changed.revision?.reason, "spot flipped");
  const mid = start + 30_000;
  assert.throws(
    () => reviseLockedCall(id, "AT STRIKE", "again", mid, freshSpot(mid, 80000)),
    /second change is refused/,
  );
  const refused = loadLocks().find((row) => row.windowId === id);
  assert.equal(refused?.lockedCall, "UP");
  assert.equal(refused?.revisedCall, "DOWN");
  assert.equal(refused?.revision?.reason, "spot flipped");
  assert.equal(refused?.revisionRefusal?.attempted, "AT STRIKE");
  assert.equal(refused?.revisionRefusal?.reason, "again");
  assert.throws(
    () => reviseLockedCall(id, "UP", "third", start + 59_000, freshSpot(start + 59_000)),
    /already refused/,
  );
  assert.equal(loadLocks().find((row) => row.windowId === id)?.revisionRefusal?.attempted, "AT STRIKE");
});

test("a stale spot during minute 10 cannot change the call and does not use it up", () => {
  const id = commitOnPostedStrike("STALE-CHANGE");
  const start = MINUTE_10_OPEN + 10 * 60_000;
  const mid = start + 30_000;
  assert.throws(
    () => reviseLockedCall(id, "DOWN", "stale at 10:00", start, { price: 80100, ts: start - 31_000, source: "manual" }),
    /stale/,
  );
  assert.throws(
    () => reviseLockedCall(id, "DOWN", "stale at 10:30", mid, { price: 79000, ts: mid - 31_000, source: "manual" }),
    /stale/,
  );
  const untouched = loadLocks().find((row) => row.windowId === id);
  assert.equal(untouched?.lockedCall, "UP");
  assert.equal(untouched?.revisedCall, undefined);
  assert.equal(untouched?.revision, undefined);
  assert.equal(untouched?.revisionRefusal, undefined);
  const changed = reviseLockedCall(id, "DOWN", "fresh after stale", mid, freshSpot(mid));
  assert.equal(changed.revisedCall, "DOWN");
  assert.equal(changed.revision?.reason, "fresh after stale");
  assert.equal(changed.revisionRefusal, undefined);
});

test("a window the desk missed is marked MISSED and is never back-filled", () => {
  const now = Date.now();
  const active: ContractWindow = {
    ...contract(),
    openTime: new Date(now - 60_000).toISOString(),
    closeTime: new Date(now + 14 * 60_000).toISOString(),
  };
  maintainWindows({
    active, upcoming: null, spot: { price: 80100, ts: now, source: "manual" }, now,
  });
  assert.equal(loadLocks().length, 1);
  assert.equal(loadLocks()[0].missed, true);
  assert.equal(loadLocks()[0].lockedCall, null);
  maintainWindows({
    active, upcoming: null, spot: { price: 77000, ts: now, source: "manual" }, now,
  });
  assert.equal(loadLocks().length, 1);
  assert.equal(loadLocks()[0].lockedCall, null);
  assert.throws(() => lockFromLive(active, { price: 80100, ts: now, source: "manual" }, [], now), /already opened/);
  assert.equal(loadLocks()[0].lockedCall, null);

  const upcoming: ContractWindow = {
    ticker: "LATE", series: "KXBTC15M", market: "15m", strike: null,
    openTime: new Date(now + 10_000).toISOString(),
    closeTime: new Date(now + 15 * 60_000 + 10_000).toISOString(),
    yesAsk: 0, noAsk: 0,
  };
  const openLate = Date.parse(upcoming.openTime!);
  maintainWindows({
    active: null, upcoming, spot: { price: 80000, ts: openLate - 1000, source: "manual" }, now: openLate - 1000,
  });
  const waitingLate = loadLocks().find((row) => row.ticker === "LATE");
  assert.equal(waitingLate?.awaitingStrike, true);
  assert.equal(waitingLate?.lockedCall, null);
  assert.equal(waitingLate?.strike, null);
  const postedAt = openLate + 60_000;
  maintainWindows({
    active: { ...upcoming, strike: 80500 }, upcoming: null,
    spot: { price: 81000, ts: postedAt - 31_000, source: "manual" }, now: postedAt,
  });
  const stillWaiting = loadLocks().find((row) => row.ticker === "LATE");
  assert.equal(stillWaiting?.awaitingStrike, true);
  assert.equal(stillWaiting?.lockedCall, null);
  const deadline = openLate + 5 * 60_000;
  maintainWindows({
    active: { ...upcoming, strike: 80500 }, upcoming: null,
    spot: { price: 81000, ts: deadline, source: "manual" }, now: deadline,
  });
  const late = loadLocks().find((row) => row.ticker === "LATE");
  assert.equal(late?.missed, true);
  assert.equal(late?.lockedCall, null);
  maintainWindows({
    active: { ...upcoming, strike: 80500 }, upcoming: null,
    spot: { price: 81000, ts: deadline + 1000, source: "manual" }, now: deadline + 1000,
  });
  const still = loadLocks().find((row) => row.ticker === "LATE");
  assert.equal(still?.missed, true);
  assert.equal(still?.lockedCall, null);
});


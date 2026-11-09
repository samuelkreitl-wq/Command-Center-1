import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpokenWindow, type ListedMarket } from "./window-resolve";

function market(ticker: string, close: string, status = "active", strike = 74000): ListedMarket {
  return {
    ticker, status, floorStrike: strike, closeTime: close,
    openTime: new Date(Date.parse(close) - 15 * 60_000).toISOString(),
    yesAsk: 0.45, noAsk: 0.6, yesBid: 0.4, noBid: 0.55,
  };
}

test("1:15 selects the 0115-15 close, not the 0130-30 window", () => {
  const now = Date.parse("2026-11-09T06:05:00.000Z");
  const markets = [
    market("KXBTC15M-26NOV090115-15", "2026-11-09T06:15:00.000Z"),
    market("KXBTC15M-26NOV090130-30", "2026-11-09T06:30:00.000Z"),
  ];
  const resolved = resolveSpokenWindow({ hour: 1, minute: 15 }, markets, now);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.market.ticker, "KXBTC15M-26NOV090115-15");
});

test("a closed 1:15 is refused and does not become 1:30", () => {
  const now = Date.parse("2026-11-09T06:20:00.000Z");
  const markets = [
    market("KXBTC15M-26NOV090115-15", "2026-11-09T06:15:00.000Z", "finalized"),
    market("KXBTC15M-26NOV090130-30", "2026-11-09T06:30:00.000Z"),
  ];
  const resolved = resolveSpokenWindow({ hour: 1, minute: 15, ampm: "am" }, markets, now);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, "closed");
});

test("a non-quarter time is refused", () => {
  const resolved = resolveSpokenWindow({ hour: 1, minute: 10 }, [], Date.parse("2026-11-09T06:00:00.000Z"));
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, "not_quarter");
});

test("1:15 with no am/pm in the morning picks 1:15pm when 1:15am has passed", () => {
  const now = Date.parse("2026-11-09T15:00:00.000Z");
  const markets = [
    market("KXBTC15M-26NOV090115-15", "2026-11-09T06:15:00.000Z", "finalized"),
    market("KXBTC15M-26NOV091315-15", "2026-11-09T18:15:00.000Z"),
  ];
  const resolved = resolveSpokenWindow({ hour: 1, minute: 15 }, markets, now);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.market.ticker, "KXBTC15M-26NOV091315-15");
    assert.equal(resolved.close.toISOString(), "2026-11-09T18:15:00.000Z");
  }
});

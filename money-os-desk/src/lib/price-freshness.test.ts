import { test } from "node:test";
import assert from "node:assert/strict";
import { isLivePriceStale, LIVE_PRICE_STALE_MS } from "./price-freshness";

test("live price is fresh, then stale after 30 seconds or an error", () => {
  assert.equal(isLivePriceStale(1_000, 1_000 + LIVE_PRICE_STALE_MS, false), false);
  assert.equal(isLivePriceStale(1_000, 1_000 + LIVE_PRICE_STALE_MS + 1, false), true);
  assert.equal(isLivePriceStale(null, 1_000, false), true);
  assert.equal(isLivePriceStale(1_000, 1_100, true), true);
});

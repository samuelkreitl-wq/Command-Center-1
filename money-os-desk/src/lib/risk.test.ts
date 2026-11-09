import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLimit, evaluateStop, quoteIsStale } from "./risk";

const order = { action: "buy" as const, limit: 0.4, cancelled: false, expiresAt: 10_000 };

test("buy and sell limits fill at the limit, through it, and not before it", () => {
  assert.deepEqual(evaluateLimit(order, { bid: 0.39, ask: 0.4 }, 1_000), { status: "filled", fillPrice: 0.4 });
  assert.deepEqual(evaluateLimit(order, { bid: 0.1, ask: 0.2 }, 1_000), { status: "filled", fillPrice: 0.2 });
  assert.deepEqual(evaluateLimit(order, { bid: 0.5, ask: 0.55 }, 1_000), { status: "resting", fillPrice: null });
  const sell = { ...order, action: "sell" as const };
  assert.deepEqual(evaluateLimit(sell, { bid: 0.4, ask: 0.45 }, 1_000), { status: "filled", fillPrice: 0.4 });
  assert.deepEqual(evaluateLimit(sell, { bid: 0.7, ask: 0.75 }, 1_000), { status: "filled", fillPrice: 0.7 });
  assert.deepEqual(evaluateLimit(sell, { bid: 0.3, ask: 0.35 }, 1_000), { status: "resting", fillPrice: null });
});

test("a limit expires at the window close and a cancel does not fill", () => {
  assert.equal(evaluateLimit(order, { bid: 0.1, ask: 0.1 }, 10_000).status, "expired");
  assert.equal(evaluateLimit(order, { bid: 0.1, ask: 0.1 }, 10_001).fillPrice, null);
  assert.equal(evaluateLimit({ ...order, cancelled: true }, { bid: 0.1, ask: 0.1 }, 1_000).status, "cancelled");
  assert.equal(quoteIsStale(1_000, 40_000), true);
  assert.equal(quoteIsStale(20_000, 40_000), false);
});

test("stops fire on percent, dollars, or whichever is reached first, and only once", () => {
  const base = { entry: 0.8, count: 1, stale: false, alreadyFired: false };
  assert.equal(evaluateStop({ ...base, mark: 0.6, stop: { percent: 0.25, dollars: null } }).reason, "percent");
  assert.equal(evaluateStop({ ...base, mark: 0.7, stop: { percent: null, dollars: 0.1 } }).reason, "dollars");
  assert.equal(evaluateStop({ ...base, mark: 0.69, stop: { percent: 0.5, dollars: 0.1 } }).reason, "dollars");
  assert.equal(evaluateStop({ ...base, mark: 0.3, stop: { percent: 0.5, dollars: 0.1 } }).reason, "percent_and_dollars");
  assert.equal(evaluateStop({ ...base, mark: 0.78, stop: { percent: 0.25, dollars: 0.1 } }).fire, false);
  assert.equal(evaluateStop({ ...base, mark: 0.1, stop: { percent: 0.25, dollars: 0.1 }, stale: true }).fire, false);
  assert.equal(evaluateStop({ ...base, mark: 0.1, stop: { percent: 0.25, dollars: 0.1 }, alreadyFired: true }).fire, false);
  assert.equal(evaluateStop({ ...base, mark: null, stop: { percent: 0.25, dollars: null } }).fire, false);
  const sized = evaluateStop({ entry: 0.5, count: 2, mark: 0.45, stop: { percent: null, dollars: 0.1 }, stale: false, alreadyFired: false });
  assert.equal(sized.fire, true);
  assert.equal(sized.reason, "dollars");
});

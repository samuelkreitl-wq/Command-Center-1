import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildV2BuyOrder,
  clearsEdgeThreshold,
  conservativeDevig,
  edgeCents,
  kellyFraction,
  lognormalAbove,
  quarterKellyContracts,
  takerFeeDollars,
} from "./pricing";

test("taker fee rounds up to the cent and matches the 39 cent example", () => {
  assert.equal(takerFeeDollars(0.39, 1), 0.02);
  assert.equal(takerFeeDollars(0.39, 10), 0.17);
  assert.equal(takerFeeDollars(0.5, 1), 0.02);
  assert.equal(takerFeeDollars(0, 1), 0);
});

test("edge is fair minus ask minus the per-contract fee", () => {
  const cents = edgeCents(0.5, 0.39, 1);
  assert.ok(Math.abs(cents - 9) < 1e-9);
  assert.equal(clearsEdgeThreshold(cents, 0.39), true);
  assert.equal(clearsEdgeThreshold(1.9, 0.4), false);
  assert.equal(clearsEdgeThreshold(2, 0.9), false);
});

test("quarter Kelly sizes from the shard bankroll and the depth", () => {
  assert.ok(Math.abs(kellyFraction(0.6, 0.4) - (0.2 / 0.6)) < 1e-9);
  assert.equal(quarterKellyContracts(0.6, 0.4, 100, 50), 20);
  assert.equal(quarterKellyContracts(0.6, 0.4, 100, 3), 3);
  assert.equal(quarterKellyContracts(0.4, 0.5, 100, 10), 0);
});

test("lognormal fair is near one half at the strike and respects distance", () => {
  const at = lognormalAbove(100, 100, 0.02);
  assert.ok(at > 0.45 && at < 0.5);
  assert.ok(lognormalAbove(110, 100, 0.02) > 0.9);
  assert.ok(lognormalAbove(90, 100, 0.02) < 0.1);
  assert.equal(lognormalAbove(101, 100, 0), 1);
});

test("no-vig fair is the lower of the power and multiplicative methods", () => {
  const out = conservativeDevig([0.6, 0.5]);
  assert.ok(out);
  assert.ok(Math.abs(out.fair[0] + out.fair[1] - Math.min(1, out.power[0] + out.power[1])) < 1e-6 || out.fair[0] <= out.multiplicative[0] + 1e-9);
  assert.ok(out.fair[0] <= out.multiplicative[0] + 1e-9);
  assert.ok(out.fair[1] <= out.multiplicative[1] + 1e-9);
  assert.ok(out.fair[0] <= out.power[0] + 1e-9);
});

test("buying NO is an ask on YES at one minus the NO price", () => {
  const body = buildV2BuyOrder({
    ticker: "KXTEST-1",
    side: "NO",
    count: 10,
    price: 0.4,
    exchangeIndex: 2,
    clientOrderId: "ord-1",
  });
  assert.equal(body.side, "ask");
  assert.equal(body.price, "0.6000");
  assert.equal(body.count, "10.00");
  assert.equal(body.time_in_force, "immediate_or_cancel");
  assert.equal(body.exchange_index, 2);
  assert.equal(body.self_trade_prevention_type, "taker_at_cross");
  const yes = buildV2BuyOrder({
    ticker: "KXTEST-1",
    side: "YES",
    count: 1.5,
    price: 0.57,
    exchangeIndex: 0,
    clientOrderId: "ord-2",
  });
  assert.equal(yes.side, "bid");
  assert.equal(yes.price, "0.5700");
  assert.equal(yes.count, "1.50");
});

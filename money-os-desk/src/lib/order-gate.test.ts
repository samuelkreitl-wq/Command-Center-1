import { test } from "node:test";
import assert from "node:assert/strict";
import { assessExecute, hashOrder, overCap, type OrderIntent, type Proposal } from "./order-gate";

function order(patch: Partial<OrderIntent> = {}): OrderIntent {
  return { ticker: "KXBTC15M-TEST-0115-15", side: "yes", action: "buy", count: 1, limitPrice: 0.4, clientOrderId: "cid-1", ...patch };
}

function proposal(patch: Partial<Proposal> = {}, intent = order()): Proposal {
  return { id: "p1", order: intent, orderHash: hashOrder(intent), expiresAt: 10_000, used: false, cancelled: false, confirmed: false, meta: {}, ...patch };
}

const base = { now: 1_000, tradingEnabled: true, freshAsk: 0.4, positionBlocked: false, modeAllowsLive: true };

function reasonOf(result: { ok: true } | { ok: false; reason: string }): string {
  if (result.ok) return "ok";
  return result.reason;
}

test("confirm gate refusals", () => {
  const live = proposal();
  assert.equal(reasonOf(assessExecute({ ...base, confirm: false, proposal: live, orderHash: live.orderHash })), "no_confirm");
  assert.equal(reasonOf(assessExecute({ ...base, confirm: true, proposal: null, orderHash: "x" })), "missing");
  assert.equal(reasonOf(assessExecute({ ...base, confirm: true, proposal: proposal({ expiresAt: 500 }), orderHash: hashOrder(order()) })), "expired");
  assert.equal(reasonOf(assessExecute({ ...base, confirm: true, proposal: proposal({ used: true }), orderHash: hashOrder(order()) })), "reused");
  assert.equal(reasonOf(assessExecute({ ...base, confirm: true, proposal: live, orderHash: "tampered" })), "tampered");
  const fat = order({ count: 11 });
  assert.equal(reasonOf(assessExecute({ ...base, confirm: true, proposal: proposal({}, fat), orderHash: hashOrder(fat) })), "over_cap");
  assert.equal(overCap(order({ count: 10, limitPrice: 0.8 }), 10, 5), true);
  assert.equal(reasonOf(assessExecute({ ...base, confirm: true, proposal: live, orderHash: live.orderHash, tradingEnabled: false })), "trading_disabled");
  assert.equal(reasonOf(assessExecute({ ...base, confirm: true, proposal: live, orderHash: live.orderHash, freshAsk: 0.5 })), "price_moved");
  assert.equal(assessExecute({ ...base, confirm: true, proposal: live, orderHash: live.orderHash }).ok, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store";
import { createRuntime } from "./runtime";
import { readConfig } from "./config";
import type { OrderIntent } from "../money-os-desk/src/lib/order-gate";

const order = (ticker = "KXBTC15M-TEST-0115-15"): OrderIntent => ({
  ticker, side: "yes", action: "buy", count: 1, limitPrice: 0.4, clientOrderId: `cid-${ticker}`,
});

async function boot(env: Record<string, string | undefined>, hooks: {
  quote?: number | null;
  place?: () => Promise<{ orderId: string }>;
  exposure?: { blocked: boolean; side?: "yes" | "no"; count?: number; price?: number };
} = {}) {
  const store = await openStore({ driver: "jsonl", path: mkdtempSync(join(tmpdir(), "desk-rt-")) });
  let posts = 0;
  const runtime = createRuntime({
    store,
    env,
    fetchImpl: async () => { throw new Error("network"); },
    fetchQuote: async () => hooks.quote === undefined ? 0.4 : hooks.quote,
    fetchExposure: async () => hooks.exposure ?? { blocked: false },
    placeOrder: hooks.place ?? (async () => { posts += 1; return { orderId: "ord-1" }; }),
  });
  return { runtime, posts: () => posts, store };
}

test("deploy defaults are paper, trading off, and demo", () => {
  const config = readConfig({});
  assert.equal(config.mode, "paper");
  assert.equal(config.tradingEnabled, false);
  assert.equal(config.kalshiEnv, "demo");
  assert.equal(readConfig({ MODE: "PAPER" }).mode, "paper");
});

test("paper mode with keys and trading enabled places no order", async () => {
  const { runtime, posts } = await boot({
    MODE: "paper", TRADING_ENABLED: "true", KALSHI_API_KEY_ID: "key", KALSHI_PRIVATE_KEY: "pem",
  });
  const held = runtime.holdProposal(order());
  assert.equal(held.ok, true);
  if (!held.ok) return;
  const result = await runtime.execute({ proposalId: held.proposal.id, orderHash: held.proposal.orderHash, confirm: true });
  assert.equal(result.ok, false);
  assert.equal("reason" in result ? result.reason : "", "mode_paper");
  assert.equal(posts(), 0);
});

test("concurrent double execute sends one order", async () => {
  let posts = 0;
  const { runtime } = await boot({ MODE: "live", TRADING_ENABLED: "true", KALSHI_API_KEY_ID: "key", KALSHI_PRIVATE_KEY: "pem" }, {
    place: async () => {
      posts += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { orderId: "ord-1" };
    },
  });
  const held = runtime.holdProposal(order());
  assert.equal(held.ok, true);
  if (!held.ok) return;
  const [a, b] = await Promise.all([
    runtime.execute({ proposalId: held.proposal.id, orderHash: held.proposal.orderHash, confirm: true }),
    runtime.execute({ proposalId: held.proposal.id, orderHash: held.proposal.orderHash, confirm: true }),
  ]);
  assert.equal(posts, 1);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
});

test("an existing position and a second proposal on that ticker are refused; another ticker is not", async () => {
  const { runtime, posts, store } = await boot({ MODE: "live", TRADING_ENABLED: "true", KALSHI_API_KEY_ID: "key", KALSHI_PRIVATE_KEY: "pem" });
  const ticker = "KXBTC15M-TEST-0115-15";
  await store.setKv("live-ledger", JSON.stringify({ [ticker]: { ticker, side: "yes", count: 1, price: 0.4, status: "open", clientOrderId: "old" } }));
  const held = runtime.holdProposal(order(ticker));
  assert.equal(held.ok, true);
  if (!held.ok) return;
  const blocked = await runtime.execute({ proposalId: held.proposal.id, orderHash: held.proposal.orderHash, confirm: true });
  assert.equal(blocked.ok, false);
  assert.match("message" in blocked ? blocked.message : "", /Position already held on KXBTC15M-TEST-0115-15/);
  assert.equal(posts(), 0);
  const first = runtime.holdProposal(order("KXBTC15M-TEST-0130-30"));
  const second = runtime.holdProposal(order("KXBTC15M-TEST-0130-30"));
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
});

test("missing confirmation, a moved price, and a disabled switch are refused", async () => {
  const live = { MODE: "live", TRADING_ENABLED: "true", KALSHI_API_KEY_ID: "key", KALSHI_PRIVATE_KEY: "pem" };
  const quiet = await boot(live);
  const held = quiet.runtime.holdProposal(order());
  assert.equal(held.ok, true);
  if (!held.ok) return;
  const unconfirmed = await quiet.runtime.execute({ proposalId: held.proposal.id, orderHash: held.proposal.orderHash, confirm: false });
  assert.equal(unconfirmed.ok, false);
  assert.equal("reason" in unconfirmed ? unconfirmed.reason : "", "no_confirm");
  const moved = await boot(live, { quote: 0.5 });
  const movedHold = moved.runtime.holdProposal(order("KXBTC15M-TEST-0130-30"));
  assert.equal(movedHold.ok, true);
  if (!movedHold.ok) return;
  const movedResult = await moved.runtime.execute({ proposalId: movedHold.proposal.id, orderHash: movedHold.proposal.orderHash, confirm: true });
  assert.equal(movedResult.ok, false);
  assert.equal("reason" in movedResult ? movedResult.reason : "", "price_moved");
  assert.equal(moved.posts(), 0);
  const off = await boot({ ...live, TRADING_ENABLED: "false" });
  const offHold = off.runtime.holdProposal(order());
  assert.equal(offHold.ok, true);
  if (!offHold.ok) return;
  const offResult = await off.runtime.execute({ proposalId: offHold.proposal.id, orderHash: offHold.proposal.orderHash, confirm: true });
  assert.equal(offResult.ok, false);
  assert.equal("reason" in offResult ? offResult.reason : "", "trading_disabled");
  assert.equal(off.posts(), 0);
});

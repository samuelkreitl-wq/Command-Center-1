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
  place?: (order?: OrderIntent) => Promise<{ orderId: string }>;
  exposure?: { blocked: boolean; side?: "yes" | "no"; count?: number; price?: number };
  book?: { yesBid: number | null; yesAsk: number | null; noBid: number | null; noAsk: number | null; ts: number | null } | null;
  cancel?: (orderId: string) => Promise<void>;
} = {}) {
  const store = await openStore({ driver: "jsonl", path: mkdtempSync(join(tmpdir(), "desk-rt-")) });
  let posts = 0;
  const sent: OrderIntent[] = [];
  const runtime = createRuntime({
    store,
    env,
    fetchImpl: async () => { throw new Error("network"); },
    fetchQuote: async () => hooks.quote === undefined ? 0.4 : hooks.quote,
    fetchBook: hooks.book === undefined ? undefined : async () => hooks.book ?? null,
    fetchExposure: async () => hooks.exposure ?? { blocked: false },
    cancelOrder: hooks.cancel,
    placeOrder: hooks.place ?? (async (order) => { posts += 1; if (order) sent.push(order); return { orderId: "ord-1" }; }),
  });
  return { runtime, posts: () => posts, sent, store };
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

test("the recorded loss is seeded once and counted in paper accuracy", async () => {
  const { runtime, store } = await boot({});
  const first = await runtime.trades();
  const entries = first.filter((row) => row.kind === "entry" && row.ticker === "KXBTCD-26NOV0902-T74299.99");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind === "entry" ? entries[0].source : "", "recorded");
  await runtime.stats();
  await runtime.trades();
  const secondRuntime = createRuntime({ store, env: {}, fetchImpl: async () => { throw new Error("network"); } });
  const again = await secondRuntime.trades();
  assert.equal(again.filter((row) => row.kind === "entry" && row.id === "recorded-kxbtcd-26nov0902-yes").length, 1);
  const stats = await runtime.stats();
  assert.equal(stats.losses, 1);
  assert.equal(stats.settled, 1);
  assert.equal(stats.winRate, 0);
  const learning = await runtime.learning();
  assert.equal(learning.overall.n, 1);
  assert.equal(learning.overall.hits, 0);
  assert.equal(learning.recorded, 1);
  assert.ok(learning.byTimeframe.every((row) => row.n === 0));
});

test("the risk monitor fires a pre-authorized stop once, and stale or disabled trading does not send", async () => {
  const live = { MODE: "live", TRADING_ENABLED: "true", KALSHI_ENV: "demo", KALSHI_API_KEY_ID: "key", KALSHI_PRIVATE_KEY: "pem" };
  const ticker = "KXBTC15M-TEST-0115-15";
  const position = {
    ticker, side: "yes", count: 1, price: 0.8, status: "open", clientOrderId: "cid",
    stop: { percent: 0.25, dollars: null }, stopFired: false, stopAuthorized: true,
  };
  const fresh = { yesBid: 0.5, yesAsk: 0.55, noBid: 0.45, noAsk: 0.5, ts: Date.now() };
  const armed = await boot(live, { book: fresh });
  await armed.store.setKv("live-ledger", JSON.stringify({ [ticker]: position }));
  await armed.runtime.riskTick();
  await armed.runtime.riskTick();
  assert.equal(armed.posts(), 1);
  assert.equal(armed.sent[0]?.action, "sell");
  assert.equal(armed.runtime.config.kalshiEnv, "demo");
  const journal = await armed.store.journalRows();
  const stop = journal.filter((row) => (row as { kind?: string }).kind === "stop" && (row as { sent?: boolean }).sent === true);
  assert.equal(stop.length, 1);
  assert.equal((stop[0] as { reason?: string }).reason, "percent");
  assert.equal((stop[0] as { price?: number }).price, 0.5);
  assert.equal(typeof (stop[0] as { time?: number }).time, "number");
  const stale = await boot(live, { book: { ...fresh, ts: Date.now() - 60_000 } });
  await stale.store.setKv("live-ledger", JSON.stringify({ [ticker]: position }));
  await stale.runtime.riskTick();
  assert.equal(stale.posts(), 0);
  const off = await boot({ ...live, TRADING_ENABLED: "false" }, { book: fresh });
  await off.store.setKv("live-ledger", JSON.stringify({ [ticker]: position }));
  await off.runtime.riskTick();
  assert.equal(off.posts(), 0);
  const paper = await boot({ ...live, MODE: "paper" }, { book: fresh });
  await paper.store.setKv("live-ledger", JSON.stringify({ [ticker]: position }));
  await paper.runtime.riskTick();
  assert.equal(paper.posts(), 0);
});

test("a confirmed buy below the ask rests, and the monitor fills it only when the ask reaches the limit", async () => {
  const live = { MODE: "live", TRADING_ENABLED: "true", KALSHI_ENV: "demo", KALSHI_API_KEY_ID: "key", KALSHI_PRIVATE_KEY: "pem" };
  const { runtime, posts, store } = await boot(live, { book: { yesBid: 0.39, yesAsk: 0.5, noBid: 0.5, noAsk: 0.61, ts: Date.now() } });
  const held = runtime.holdProposal(
    { ...order(), limitPrice: 0.3 },
    { referencePrice: 0.5, closeTime: new Date(Date.now() + 60_000).toISOString(), stop: null },
  );
  assert.equal(held.ok, true);
  if (!held.ok) return;
  const placed = await runtime.execute({ proposalId: held.proposal.id, orderHash: held.proposal.orderHash, confirm: true });
  assert.equal(placed.ok, true);
  assert.equal(posts(), 1);
  assert.equal("status" in placed ? placed.status : "", "resting");
  await runtime.riskTick();
  const still = JSON.parse((await store.getKv("live-ledger")) || "{}") as Record<string, { status: string }>;
  assert.equal(still[order().ticker].status, "resting");
  const touched = await boot(live, { book: { yesBid: 0.2, yesAsk: 0.3, noBid: 0.7, noAsk: 0.8, ts: Date.now() } });
  await touched.store.setKv("live-orders", (await store.getKv("live-orders")) || "[]");
  await touched.store.setKv("live-ledger", (await store.getKv("live-ledger")) || "{}");
  await touched.runtime.riskTick();
  const filled = JSON.parse((await touched.store.getKv("live-ledger")) || "{}") as Record<string, { status: string; price: number }>;
  assert.equal(filled[order().ticker].status, "open");
  assert.equal(filled[order().ticker].price, 0.3);
});

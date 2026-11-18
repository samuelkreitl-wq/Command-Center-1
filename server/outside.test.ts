import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { fingerprint, markPosition, orderOrigin, readOutsideActivity, settledPnl, tickerOrigins } from "./outside.js";

test("empty client_order_id is outside; a desk id is desk; an optional prefix marks momentum", () => {
  assert.equal(orderOrigin({ client_order_id: "" }), "outside");
  assert.equal(orderOrigin({ client_order_id: null }), "outside");
  assert.equal(orderOrigin({ client_order_id: "5f0c2a8e-1111" }), "desk");
  assert.equal(orderOrigin({ client_order_id: "mom-123" }, "mom-"), "momentum-tag");
  const origins = tickerOrigins([
    { order_id: "1", ticker: "A", client_order_id: "" },
    { order_id: "2", ticker: "B", client_order_id: "x" },
    { order_id: "3", ticker: "C", client_order_id: "" },
    { order_id: "4", ticker: "C", client_order_id: "y" },
  ]);
  assert.equal(origins.get("A"), "outside");
  assert.equal(origins.get("B"), "desk");
  assert.equal(origins.get("C"), "mixed");
});

test("settled P&L handles a netted YES-then-flipped-to-NO ticker", () => {
  // Shape of KXBTCD-26NOV1804-T64499.99 on Nov 18: bought 99.16 YES at 88c, sold at 90c and again at 99c, settled YES.
  const pnl = settledPnl({ ticker: "T", market_result: "yes", yes_count_fp: "99.16", no_count_fp: "198.32", yes_total_cost_dollars: "87.2608", no_total_cost_dollars: "10.9076", fee_cost: "1.3578" });
  assert.equal(pnl, -0.37);
  assert.equal(settledPnl({ ticker: "W", market_result: "no", yes_count_fp: "161.21", no_count_fp: "0", yes_total_cost_dollars: "27.4057", no_total_cost_dollars: "0", fee_cost: "1.5924" }), -29);
});

test("open positions are marked at the bid on the held side", () => {
  const yes = markPosition({ ticker: "K", position_fp: "13.79", market_exposure_dollars: "3.7981", fees_paid_dollars: "0.1927" }, { yes_bid_dollars: "0.13", no_bid_dollars: "0.86" });
  assert.equal(yes.side, "YES");
  assert.equal(yes.value, 1.79);
  assert.equal(yes.unrealized, -2.2);
  const no = markPosition({ ticker: "M", position_fp: "-124", market_exposure_dollars: "78.12", fees_paid_dollars: "2.0234" }, { yes_bid_dollars: "0.4", no_bid_dollars: "0.58" });
  assert.equal(no.side, "NO");
  assert.equal(no.value, 71.92);
  assert.equal(markPosition({ ticker: "Z", position_fp: "1" }, null).value, null);
});

test("fingerprint counts market orders, fractional sizes, quick take-profit sells and same-second funding", () => {
  const fp = fingerprint([
    { order_id: "a", ticker: "KXITFMATCH-X", action: "buy", type: "market", initial_count_fp: "13.79", created_time: "2026-11-18T12:22:13Z" },
    { order_id: "b", ticker: "KXITFMATCH-X", action: "sell", type: "limit", initial_count_fp: "13.79", created_time: "2026-11-18T12:22:28Z" },
  ], [{ amount: "13.67", created_ts: Date.parse("2026-11-18T12:22:13Z") / 1000 }]);
  assert.equal(fp.marketOrders, 1);
  assert.equal(fp.fractionalSizes, 2);
  assert.equal(fp.takeProfitSellWithin2MinOfBuy, 1);
  assert.equal(fp.transfersSameSecondAsOrder, 1);
  assert.equal(fp.series[0].name, "KXITFMATCH");
});

test("readOutsideActivity only issues GET requests and separates desk from outside", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = { KALSHI_API_KEY_ID: "test-id", KALSHI_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const methods: string[] = [];
  const now = Date.parse("2026-11-18T13:00:00Z");
  const signed = async (_env: Record<string, string | undefined>, method: string, path: string) => {
    methods.push(method);
    if (path.startsWith("/portfolio/orders?status=resting")) return { status: 200, body: { orders: [{ order_id: "o2", ticker: "KEL", action: "sell", side: "yes", type: "limit", yes_price_dollars: "0.75", initial_count_fp: "13.79", remaining_count_fp: "13.79", client_order_id: "", created_time: "2026-11-18T12:22:28Z", exchange_index: 3 }] } };
    if (path.startsWith("/portfolio/orders")) return { status: 200, body: { orders: [
      { order_id: "o1", ticker: "KEL", action: "buy", side: "yes", type: "market", yes_price_dollars: "0.99", initial_count_fp: "13.79", fill_count_fp: "13.79", client_order_id: "", created_time: "2026-11-18T12:22:13Z", exchange_index: 3 },
      { order_id: "o2", ticker: "KEL", action: "sell", side: "yes", type: "limit", yes_price_dollars: "0.75", initial_count_fp: "13.79", client_order_id: "", created_time: "2026-11-18T12:22:28Z", exchange_index: 3 },
      { order_id: "o3", ticker: "MIN", action: "sell", side: "yes", type: "limit", yes_price_dollars: "0.36", initial_count_fp: "124", fill_count_fp: "124", client_order_id: "5f0c2a8e", created_time: "2026-11-18T12:38:20Z", exchange_index: 0 },
    ] } };
    if (path.startsWith("/portfolio/fills")) return { status: 200, body: { fills: [
      { order_id: "o1", ticker: "KEL", action: "buy", side: "yes", count_fp: "13.79", yes_price_dollars: "0.27", fee_cost: "0.19" },
      { order_id: "o3", ticker: "MIN", action: "sell", side: "no", count_fp: "124", yes_price_dollars: "0.37", fee_cost: "2.02" },
    ] } };
    if (path.startsWith("/portfolio/positions")) return { status: 200, body: { market_positions: [
      { ticker: "KEL", position_fp: "13.79", market_exposure_dollars: "3.7981", fees_paid_dollars: "0.1927", exchange_index: 3 },
      { ticker: "MIN", position_fp: "-124", market_exposure_dollars: "78.12", fees_paid_dollars: "2.0234", exchange_index: 0 },
    ] } };
    if (path.startsWith("/portfolio/settlements")) return { status: 200, body: { settlements: [] } };
    if (path.startsWith("/portfolio/intra_exchange_instance_transfers")) return { status: 200, body: { transfers: [
      { transfer_id: "t1", amount: "13.6717", source_exchange_shard: 2, destination_exchange_shard: 3, status: "complete", created_ts: Date.parse("2026-11-18T12:22:13Z") / 1000 },
      { transfer_id: "t2", client_transfer_id: "be5b", amount: "9.25", source_exchange_shard: 3, destination_exchange_shard: 0, status: "complete", created_ts: Date.parse("2026-11-18T12:38:15Z") / 1000 },
    ] } };
    return { status: 404, body: { message: "unexpected " + path } };
  };
  const out = await readOutsideActivity(env, 24, { signed, market: async () => ({ ticker: "KEL", yes_bid_dollars: "0.13", no_bid_dollars: "0.86" }), now: () => now });
  assert.ok(!out.needsKey);
  if (out.needsKey) return;
  assert.deepEqual([...new Set(methods)], ["GET"]);
  assert.equal(out.orders.length, 2);
  assert.equal(out.restingOrders.length, 1);
  assert.equal(out.fills.length, 1);
  assert.equal(out.openPositions.length, 1);
  assert.equal(out.openPositions[0].ticker, "KEL");
  assert.equal(out.transfers.length, 1);
  assert.equal(out.deskTransfers, 1);
  assert.equal(out.pnl.openAtBid, -2.2);
  assert.deepEqual(out.errors, []);
});

test("without Kalshi keys the panel reports needsKey and makes no request", async () => {
  let called = false;
  const out = await readOutsideActivity({}, 24, { signed: async () => { called = true; return { status: 200, body: {} }; } });
  assert.equal(out.needsKey, true);
  assert.equal(called, false);
});

test("the outside panel source has no write path", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("./outside.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../money-os-desk/src/momentum.tsx", import.meta.url), "utf8");
  for (const src of [server, ui]) {
    assert.doesNotMatch(src, /"(POST|PUT|DELETE|PATCH)"/);
    assert.doesNotMatch(src, /orders\.js|placeConfirmedOrder|\/batched|\/amend|\/decrease|api_keys/);
  }
  assert.doesNotMatch(ui, /method:\s*"/);
});

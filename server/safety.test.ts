import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { approvalPasswordOk } from "./password.js";
import { signKalshiRequest } from "./kalshi-sign.js";
import { placeConfirmedOrder } from "./orders.js";
import { buildSystemPrompt, redactSecrets } from "./chat.js";
import { msUntilNextEtHour } from "./scheduler.js";
import { runScan } from "./scan.js";
import { arbReturn } from "./sports.js";
import { weatherFairYes } from "./fair.js";
import { buildV2BuyOrder } from "../money-os-desk/src/lib/pricing.js";

test("approval password fails closed and does not echo itself", () => {
  assert.equal(approvalPasswordOk(undefined, "correct-horse"), false);
  assert.equal(approvalPasswordOk("", "correct-horse"), false);
  assert.equal(approvalPasswordOk("wrong", "correct-horse"), false);
  assert.equal(approvalPasswordOk("correct-horse", undefined), false);
  assert.equal(approvalPasswordOk("correct-horse", "correct-horse"), true);
  assert.equal(approvalPasswordOk("correct-horse", "correct-horses"), false);
});

test("Kalshi signature covers method and path and drops the query", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const post = "100POST/trade-api/v2/portfolio/events/orders";
  const check = (signature: string, message: string) => verify("sha256", Buffer.from(message), {
    key: publicKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }, Buffer.from(signature, "base64"));
  const a = signKalshiRequest(pem, "100", "POST", "/trade-api/v2/portfolio/events/orders");
  const b = signKalshiRequest(pem, "100", "POST", "/trade-api/v2/portfolio/events/orders?exchange_index=2");
  const c = signKalshiRequest(pem, "100", "GET", "/trade-api/v2/portfolio/balance");
  assert.equal(check(a, post), true);
  assert.equal(check(b, post), true);
  assert.equal(check(c, post), false);
  assert.equal(check(c, "100GET/trade-api/v2/portfolio/balance"), true);
});

test("orders reject a missing password, a wrong password, chat, and the scheduler before any exchange call", async () => {
  let calls = 0;
  const fetchMarket = async () => {
    calls += 1;
    throw new Error("market fetch should not run");
  };
  const base = {
    ticker: "KXBTCD-TEST",
    side: "NO" as const,
    count: 2,
    price: 0.4,
    acknowledgedPrice: 0.4,
    acknowledgedEdge: 3,
    serverEdge: 3,
    confirm: true as const,
  };
  const env = { MONEY_DESK_APPROVAL_PASSWORD: "desk-secret", KALSHI_API_KEY_ID: "kid", KALSHI_PRIVATE_KEY_PEM: "not-a-key" };
  for (const attempt of [
    { ...base, source: "user-confirm" as const, password: undefined },
    { ...base, source: "user-confirm" as const, password: "nope" },
    { ...base, source: "user-confirm" as const, password: "desk-secret", confirm: false },
    { ...base, source: "schedule" as const, password: "desk-secret" },
    { ...base, source: "chat" as const, password: "desk-secret" },
    { ...base, source: "webhook" as const, password: "desk-secret" },
  ]) {
    const result = await placeConfirmedOrder(attempt, { env, fetchMarket, log: () => undefined });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    if (!result.ok) assert.match(result.error, /Nothing was placed/);
  }
  const wrong = await placeConfirmedOrder({ ...base, source: "user-confirm", password: "nope" }, { env, fetchMarket, log: () => undefined });
  const missing = await placeConfirmedOrder({ ...base, source: "user-confirm", password: "" }, { env, fetchMarket, log: () => undefined });
  assert.equal(wrong.ok, false);
  assert.equal(missing.ok, false);
  if (!wrong.ok && !missing.ok) assert.equal(wrong.error, missing.error);
});

test("a moved price and an exchange error do not send a second order", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const env = {
    MONEY_DESK_APPROVAL_PASSWORD: "desk-secret",
    KALSHI_API_KEY_ID: "kid",
    KALSHI_PRIVATE_KEY_PEM: pem,
  };
  const market = { ticker: "KXTEST-1", exchange_index: 2, yes_ask_dollars: "0.6000", no_ask_dollars: "0.4200" };
  const book = { yesAsk: 0.6, yesAskSize: 5, noAsk: 0.42, noAskSize: 8 };
  let sends = 0;
  const moved = await placeConfirmedOrder({
    source: "user-confirm",
    confirm: true,
    password: "desk-secret",
    ticker: "KXTEST-1",
    side: "NO",
    count: 2,
    price: 0.4,
    acknowledgedPrice: 0.4,
    acknowledgedEdge: 4,
    serverEdge: 4,
  }, {
    env,
    fetchMarket: async () => market,
    fetchBook: async () => book,
    send: async () => {
      sends += 1;
      return { status: 201, body: {} };
    },
    log: () => undefined,
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.code, "price_moved");
  assert.equal(sends, 0);
  if (!moved.ok) assert.equal((moved.fresh as { ask: number }).ask, 0.42);

  const sent: unknown[] = [];
  const failed = await placeConfirmedOrder({
    source: "user-confirm",
    confirm: true,
    password: "desk-secret",
    ticker: "KXTEST-1",
    side: "NO",
    count: 2,
    price: 0.42,
    acknowledgedPrice: 0.42,
    acknowledgedEdge: 1,
    serverEdge: 1,
  }, {
    env,
    fetchMarket: async () => market,
    fetchBook: async () => book,
    readCash: async () => [{ index: 2, dollars: 50, label: "crypto and commodities" }],
    send: async (body) => {
      sent.push(body);
      return { status: 400, body: { code: "insufficient_balance", message: "insufficient_balance" } };
    },
    log: () => undefined,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "exchange_rejected");
  assert.equal(sent.length, 1);
  const body = sent[0] as { side: string; price: string; count: string; exchange_index: number; time_in_force: string };
  assert.equal(body.side, "ask");
  assert.equal(body.price, "0.5800");
  assert.equal(body.count, "2.00");
  assert.equal(body.exchange_index, 2);
  assert.equal(body.time_in_force, "immediate_or_cancel");
  assert.match(failed.error, /insufficient_balance/);
  assert.match(failed.error, /no other market/i);

  let blockedSends = 0;
  const blocked = await placeConfirmedOrder({
    source: "user-confirm",
    confirm: true,
    password: "desk-secret",
    ticker: "KXTEST-1",
    side: "YES",
    count: 2,
    price: 0.6,
    acknowledgedPrice: 0.6,
    acknowledgedEdge: 1,
    serverEdge: 1,
  }, {
    env,
    fetchMarket: async () => market,
    fetchBook: async () => book,
    readCash: async () => [{ index: 2, dollars: 1, label: "crypto and commodities" }],
    send: async () => {
      blockedSends += 1;
      return { status: 201, body: {} };
    },
    log: () => undefined,
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "insufficient_balance");
  assert.equal(blockedSends, 0);
});

test("buying NO is encoded as a YES ask at one minus the price", () => {
  const body = buildV2BuyOrder({
    ticker: "KXHIGHNY-26NOV11-T66",
    side: "NO",
    count: 3,
    price: 0.37,
    exchangeIndex: 0,
    clientOrderId: "id",
  });
  assert.equal(body.side, "ask");
  assert.equal(body.price, "0.6300");
  assert.equal(body.exchange_index, 0);
});

test("the assistant prompt and the scanner cannot place orders", () => {
  const previous = process.env.MONEY_DESK_APPROVAL_PASSWORD;
  process.env.MONEY_DESK_APPROVAL_PASSWORD = "sentinel-swordfish-unique";
  const prompt = buildSystemPrompt("Never auto-bet.");
  assert.equal(prompt.includes("sentinel-swordfish-unique"), false);
  assert.match(prompt, /never place/i);
  assert.equal(redactSecrets("yes password sentinel-swordfish-unique").includes("sentinel-swordfish-unique"), false);
  process.env.MONEY_DESK_APPROVAL_PASSWORD = previous;
  for (const file of ["chat.ts", "scheduler.ts", "scan.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(source.includes("placeConfirmedOrder"), false, file);
    assert.equal(source.includes("/portfolio/events/orders"), false, file);
  }
});

test("a weather bucket is not priced as a greater-than contract", () => {
  const forecasts = [{ highF: 70, source: "NWS", issuedAt: "2026-11-11T08:00:00Z" }];
  const above = weatherFairYes(forecasts, "greater", 60, null);
  const bucket = weatherFairYes(forecasts, "between", 60, 61);
  assert.ok(above && above.fairYes > 0.8);
  assert.ok(bucket && bucket.fairYes < 0.2);
});

test("arb math uses the fee and the 1.5 percent floor", () => {
  const thin = arbReturn({ kalshiPrice: 0.5, contracts: 1, otherDecimal: 2.02 });
  assert.ok(thin != null && thin < 0.015);
  const wide = arbReturn({ kalshiPrice: 0.4, contracts: 10, otherDecimal: 3 });
  assert.ok(wide != null && wide > 0.015);
});

test("the hourly scan prices a live-shaped BTC market and does not place an order", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-"));
  const now = new Date("2026-11-11T08:00:00.000Z");
  const close = new Date(now.getTime() + 30 * 60_000).toISOString();
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 0.4);
  const get = async (url: string) => {
    if (url.includes("/series")) {
      return {
        series: [
          { ticker: "KXBTC15M", title: "BTC 15m", category: "Crypto", fee_multiplier: 1, fee_type: "quadratic", exchange_index: 2 },
          { ticker: "KXPOLITICS", title: "Race", category: "Politics", last_updated_ts: "2026-11-11T00:00:00Z", exchange_index: 0 },
        ],
      };
    }
    if (url.includes("series_ticker=KXBTC15M")) {
      return {
        markets: [{
          ticker: "KXBTC15M-26NOV110330-15",
          event_ticker: "KXBTC15M-26NOV110330",
          title: "BTC price up in next 15 mins?",
          floor_strike: 100,
          yes_ask_dollars: "0.3000",
          yes_bid_dollars: "0.2800",
          no_ask_dollars: "0.7200",
          yes_ask_size_fp: "40",
          exchange_index: 2,
          rules_primary: "If the simple average of CF Benchmarks' BRTI is at least the strike, the market resolves to Yes.",
          close_time: close,
          open_time: now.toISOString(),
          status: "active",
        }],
      };
    }
    if (url.includes("/markets?") || url.includes("series_ticker=")) return { markets: [] };
    if (url.includes("/orderbook")) {
      return { orderbook_fp: { yes_dollars: [["0.2800", "10"]], no_dollars: [["0.7000", "40"]] } };
    }
    if (url.includes("api.kraken.com") && url.includes("Ticker")) {
      return { error: [], result: { XXBTZUSD: { c: ["100.00", "1"] } } };
    }
    if (url.includes("api.kraken.com") && url.includes("OHLC")) {
      return {
        error: [],
        result: { XXBTZUSD: closes.map((closePx, i) => [1_700_000_000 + i * 60, closePx, closePx, closePx, closePx, closePx, 1, 1]) },
      };
    }
    if (url.includes("coinbase.com")) return { price: "100.00", time: now.toISOString() };
    if (url.includes("KXPOLITICS")) {
      return { markets: [{ ticker: "KXPOLITICS-1", title: "Sample race", yes_ask_dollars: "0.4000", exchange_index: 0, close_time: close, rules_primary: "Resolves on the official count." }] };
    }
    throw new Error(`unexpected ${url}`);
  };
  const report = await runScan({
    env: { MONEY_DESK_DATA_DIR: root },
    now,
    get: get as typeof import("./net.js").fetchJson,
    root,
  });
  assert.ok(report.pass.some((pick) => pick.market.ticker === "KXBTC15M-26NOV110330-15"));
  assert.ok(report.watch.some((pick) => pick.tab === "Politics" && pick.model === "no model"));
  assert.equal(report.pass.some((pick) => pick.verdict !== "PASS"), false);
  const csv = readFileSync(path.join(root, "hourly", "picks-log.csv"), "utf8");
  assert.match(csv, /KXBTC15M-26NOV110330-15/);
  assert.match(csv, /Politics/);
  assert.equal(msUntilNextEtHour(new Date("2026-11-11T08:00:00.000Z")) <= 3_600_000, true);
});

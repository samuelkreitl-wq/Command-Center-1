import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApi } from "./index.js";
import { loadTradeLog } from "./trade-log.js";
import {
  DEFAULT_FEED_URL,
  KALSHI_KEYS_MISSING,
  TRADE_LOG_REFRESH_MS,
  assertFeedUrl,
  buildTradeLog,
  etDay,
  formatEt,
  markToMarket,
  resolveFeedUrl,
  settlementPnl,
  type TradeLogInput,
} from "../money-os-desk/src/lib/trade-log.js";

const NOW = Date.parse("2026-11-11T15:30:00.000Z");

const feed = {
  generated_at: "2026-11-11T15:00:00.000Z",
  picks_today: [{
    timestamp: "2026-11-11T15:00:00.000Z",
    tab: "Crypto",
    market: "Bitcoin above strike",
    ticker: "KXBTCD-1",
    side: "no",
    price: 0.4,
    fair_prob: 0.55,
    edge: 3.2,
    stake: 10,
    verdict: "PASS",
    close_time: "2026-11-11T16:00:00.000Z",
    notes: "thin book",
    fills: [{ timestamp: "2026-11-11T15:05:00.000Z", price: 0.99, count: 2, fill_id: "feed-only" }],
    skipped: [{ timestamp: "2026-11-11T14:00:00.000Z", reason: "depth too thin" }],
  }],
  pick_log: [
    {
      timestamp: "2026-11-11T15:00:00.000Z",
      tab: "Crypto",
      market: "Bitcoin above strike",
      ticker: "KXBTCD-1",
      side: "NO",
      price: 0.4,
      fair_prob: 0.55,
      edge: 3.2,
      stake: 10,
      verdict: "PASS",
      close_time: "2026-11-11T16:00:00.000Z",
      notes: "thin book",
      fills: [],
      skipped: [],
    },
    {
      timestamp: "2026-11-10T18:00:00.000Z",
      tab: "Weather",
      market: "NYC high",
      ticker: "KXHIGHNY-1",
      side: "YES",
      price: 42,
      fair_prob: 61,
      edge: { cents_per_contract_after_fees: 2.5 },
      stake: { contracts: 4, cost_dollars: 1.68 },
      verdict: "FAIL",
      close_time: "2026-11-10T23:00:00.000Z",
      notes: "bucket",
      fills: [],
      skipped: [],
    },
  ],
  pnl: { realized: 999, unrealized: 999, total: 1998, by_day: [{ date: "2026-11-01", realized: 999, unrealized: 0, total: 999 }] },
};

function input(patch: Partial<TradeLogInput["kalshi"]> = {}, feedBody: unknown = feed): TradeLogInput {
  return {
    now: NOW,
    feed: feedBody,
    feedError: null,
    feedHost: "raw.githubusercontent.com",
    kalshi: {
      configured: true,
      error: null,
      shards: [{ index: 2, label: "crypto and commodities", dollars: 9 }],
      fills: [],
      settlements: [],
      positions: [],
      marks: {},
      fillsOk: true,
      settlementsOk: true,
      positionsOk: true,
      ...patch,
    },
  };
}

test("settlement payout minus cost and fees, dated in ET", () => {
  const pnl = settlementPnl({
    revenue: 1000,
    yes_total_cost_dollars: "4.0000",
    no_total_cost_dollars: "0.0000",
    fee_cost: "0.2000",
  });
  assert.equal(pnl, 5.8);
  assert.equal(etDay("2026-11-11T03:30:00.000Z"), "2026-11-10");
  assert.equal(formatEt("2026-11-11T15:30:00.000Z"), "Nov 11, 10:30 AM ET");
});

test("mark to market uses the held side", () => {
  assert.equal(markToMarket(10, 4, 0.55), 1.5);
  assert.equal(markToMarket(-5, 3, 0.4), 0);
  assert.equal(markToMarket(10, null, 0.55), null);
  assert.equal(markToMarket(10, 4, null), null);
});

test("live Kalshi fills and P&L replace the feed, and skipped orders stay", () => {
  const view = buildTradeLog(input({
    fills: [{
      fill_id: "live-1",
      ticker: "KXBTCD-1",
      outcome_side: "no",
      no_price_dollars: "0.4100",
      count_fp: "2.00",
      fee_cost: "0.0700",
      exchange_index: 2,
      action: "buy",
      created_time: "2026-11-11T15:10:00.000Z",
    }],
    settlements: [
      {
        ticker: "KXOLD",
        exchange_index: 2,
        revenue: 1000,
        yes_total_cost_dollars: "4.0000",
        no_total_cost_dollars: "0",
        fee_cost: "0.2000",
        settled_time: "2026-11-11T03:30:00.000Z",
      },
      {
        ticker: "KXNEW",
        exchange_index: 0,
        revenue: 200,
        yes_total_cost_dollars: "1.0000",
        no_total_cost_dollars: "0",
        fee_cost: "0",
        settled_time: "2026-11-11T15:00:00.000Z",
      },
    ],
    positions: [
      { ticker: "KXBTCD-1", exchange_index: 2, position_fp: "10.00", market_exposure_dollars: "4.0000", last_updated_ts: "2026-11-11T15:20:00.000Z" },
      { ticker: "KXNO", exchange_index: 3, position_fp: "-5.00", market_exposure_dollars: "3.0000", last_updated_ts: "2026-11-11T15:20:00.000Z" },
      { ticker: "KXMISS", exchange_index: 0, position_fp: "1.00", market_exposure_dollars: "0.5000", last_updated_ts: "2026-11-11T15:20:00.000Z" },
    ],
    marks: { "KXBTCD-1": 0.55, KXNO: 0.4, KXMISS: null },
  }));

  assert.equal(view.fills.length, 1);
  assert.equal(view.fills[0].id, "live-1");
  assert.equal(view.fills[0].source, "kalshi");
  assert.equal(view.fills[0].side, "NO");
  assert.equal(view.fills[0].price, 0.41);
  assert.equal(view.fills[0].tab, "Crypto");
  assert.equal(view.skipped.length, 1);
  assert.equal(view.skipped[0].ticker, "KXBTCD-1");
  assert.equal(view.skipped[0].reason, "depth too thin");
  assert.equal(view.picksToday.length, 1);
  assert.equal(view.picksToday[0].side, "NO");
  assert.equal(view.picksToday[0].notes, "thin book");
  assert.equal(view.pickLog[0].ticker, "KXBTCD-1");
  assert.equal(view.pickLog[1].price, 0.42);
  assert.equal(view.pickLog[1].fairProb, 0.61);
  assert.equal(view.pickLog[1].edgeCents, 2.5);
  assert.equal(view.pickLog[1].stakeContracts, 4);
  assert.equal(view.pnl.source, "kalshi");
  assert.equal(view.pnl.realized, 6.8);
  assert.equal(view.pnl.unrealized, 1.5);
  assert.equal(view.pnl.total, null);
  assert.equal(view.pnl.partial, true);
  assert.equal(view.pnl.unmarked, 1);
  assert.deepEqual(view.pnl.byDay.map((day) => day.date), ["2026-11-11", "2026-11-10"]);
  assert.equal(view.positions.find((row) => row.ticker === "KXBTCD-1")?.unrealized, 1.5);
  assert.equal(view.positions.find((row) => row.ticker === "KXNO")?.side, "NO");
  assert.equal(view.positions.find((row) => row.ticker === "KXNO")?.unrealized, 0);
  assert.equal(view.positions.find((row) => row.ticker === "KXMISS")?.unrealized, null);
  assert.equal(JSON.stringify(view).includes("999"), false);
});

test("missing keys keep the feed and do not pretend it is Kalshi", () => {
  const view = buildTradeLog(input({
    configured: false,
    fillsOk: false,
    settlementsOk: false,
    positionsOk: false,
    shards: [],
  }));
  assert.equal(view.kalshi.error, KALSHI_KEYS_MISSING);
  assert.equal(view.fills.length, 1);
  assert.equal(view.fills[0].source, "feed");
  assert.equal(view.fills[0].id, "feed-only");
  assert.equal(view.pnl.source, "feed");
  assert.equal(view.pnl.realized, 999);
  assert.match(view.pnl.note, /not a live mark/i);
  assert.equal(view.positions.length, 0);
});

test("a bad feed does not throw", () => {
  const view = buildTradeLog({
    now: NOW,
    feed: "nope",
    feedError: null,
    feedHost: null,
    kalshi: {
      configured: false,
      error: null,
      shards: [],
      fills: [],
      settlements: [],
      positions: [],
      marks: {},
      fillsOk: false,
      settlementsOk: false,
      positionsOk: false,
    },
  });
  assert.equal(view.feed.error, "Feed was not a JSON object");
  assert.equal(view.pickLog.length, 0);
  assert.equal(view.kalshi.error, KALSHI_KEYS_MISSING);
});

test("the feed URL defaults to this repo and rejects unsafe hosts", () => {
  assert.equal(resolveFeedUrl({}), DEFAULT_FEED_URL);
  assert.equal(resolveFeedUrl({ MONEY_DESK_FEED_URL: " https://example.com/feed.json " }), "https://example.com/feed.json");
  assert.equal(assertFeedUrl(DEFAULT_FEED_URL).hostname, "raw.githubusercontent.com");
  assert.throws(() => assertFeedUrl("http://example.com/feed.json"), /https/);
  assert.throws(() => assertFeedUrl("https://user:secret@example.com/feed.json"), /credentials/);
  assert.throws(() => assertFeedUrl("https://169.254.169.254/latest"), /not allowed/);
  assert.throws(() => assertFeedUrl("https://127.0.0.1/feed.json"), /not allowed/);
  assert.equal(TRADE_LOG_REFRESH_MS, 300_000);
});

test("portfolio reads cover every listed shard, page cursors, and drop duplicate fills", async () => {
  const paths: string[] = [];
  const pem = "-----BEGIN PRIVATE KEY-----\nnot-sent\n-----END PRIVATE KEY-----";
  const env = { KALSHI_API_KEY_ID: "kid-do-not-leak", KALSHI_PRIVATE_KEY_PEM: pem };
  let fillPage = 0;
  const view = await loadTradeLog({
    env,
    now: () => NOW,
    fetchFeed: async () => feed,
    fetchMarket: async () => ({ yes_bid_dollars: "0.50", yes_ask_dollars: "0.60" }),
    get: async (path: string) => {
      paths.push(path);
      if (path.startsWith("/portfolio/balance")) {
        return {
          status: 200,
          body: {
            balance_breakdown: [
              { exchange_index: 0, balance_dollars: "1.00" },
              { exchange_index: 2, balance_dollars: "9.00" },
            ],
          },
        };
      }
      if (path.startsWith("/portfolio/fills")) {
        fillPage += 1;
        const shard = new URLSearchParams(path.split("?")[1]).get("exchange_index");
        if (shard === "2" && !path.includes("cursor=")) {
          return { status: 200, body: { fills: [{ fill_id: "shared", ticker: "KXBTCD-1", outcome_side: "yes", yes_price_dollars: "0.4000", count_fp: "1.00", created_time: "2026-11-11T15:00:00.000Z", exchange_index: 2, is_taker: true, fee_cost: "0.0100" }], cursor: "page-2" } };
        }
        return {
          status: 200,
          body: {
            fills: [{ fill_id: "shared", ticker: "KXBTCD-1", outcome_side: "yes", yes_price_dollars: "0.4000", count_fp: "1.00", created_time: "2026-11-11T15:00:00.000Z", exchange_index: Number(shard ?? 0), is_taker: false, fee_cost: "0.0100" }],
            cursor: "",
          },
        };
      }
      if (path.startsWith("/portfolio/positions")) {
        const shard = new URLSearchParams(path.split("?")[1]).get("exchange_index");
        if (shard !== "2") return { status: 200, body: { market_positions: [], cursor: "" } };
        return {
          status: 200,
          body: {
            market_positions: [{ ticker: "KXBTCD-1", exchange_index: 2, position_fp: "10.00", market_exposure_dollars: "4.0000", last_updated_ts: "2026-11-11T15:20:00.000Z" }],
            cursor: "",
          },
        };
      }
      if (path.startsWith("/portfolio/settlements")) {
        return { status: 200, body: { settlements: [], cursor: "" } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  assert.equal(view.fills.length, 1);
  assert.equal(view.fills[0].source, "kalshi");
  assert.equal(view.positions.length, 1);
  assert.equal(view.positions[0].unrealized, 1.5);
  assert.equal(view.pnl.source, "kalshi");
  assert.equal(view.pnl.realized, 0);
  assert.equal(view.pnl.unrealized, 1.5);
  assert.equal(view.pnl.total, 1.5);
  assert.deepEqual(view.kalshi.shards.map((shard) => shard.dollars), [1, 9]);
  assert.ok(paths.some((path) => path.includes("/portfolio/fills") && path.includes("exchange_index=0")));
  assert.ok(paths.some((path) => path.includes("/portfolio/fills") && path.includes("exchange_index=2")));
  assert.ok(paths.some((path) => path.includes("/portfolio/positions") && path.includes("exchange_index=2") && path.includes("count_filter=position")));
  assert.ok(paths.some((path) => path.includes("cursor=page-2")));
  assert.ok(fillPage >= 3);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("kid-do-not-leak"), false);
  assert.equal(serialized.includes("BEGIN PRIVATE"), false);
  assert.equal(serialized.includes("not-sent"), false);
});

test("missing Kalshi keys skip the signed client", async () => {
  let calls = 0;
  const view = await loadTradeLog({
    env: {},
    now: () => NOW,
    fetchFeed: async () => feed,
    get: async () => {
      calls += 1;
      throw new Error("signed client should not run");
    },
  });
  assert.equal(calls, 0);
  assert.equal(view.kalshi.configured, false);
  assert.equal(view.kalshi.error, KALSHI_KEYS_MISSING);
  assert.equal(view.picksToday[0].ticker, "KXBTCD-1");
});

test("a Kalshi error stays on the view and a feed failure does not crash", async () => {
  const broken = await loadTradeLog({
    env: { KALSHI_API_KEY_ID: "kid", KALSHI_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" },
    now: () => NOW,
    fetchFeed: async () => { throw new Error("Feed HTTP 404 https://secret.example/feed?token=abc"); },
    get: async (path: string) => {
      if (path.startsWith("/portfolio/balance")) return { status: 401, body: { message: "unauthorized" } };
      return { status: 401, body: { message: "unauthorized" } };
    },
  });
  assert.match(broken.feed.error || "", /Feed HTTP 404/);
  assert.equal((broken.feed.error || "").includes("token"), false);
  assert.match(broken.kalshi.error || "", /401/);
  assert.equal(broken.pnl.source, "none");
  assert.equal(broken.positions.length, 0);
});

test("the trade log route is read-only and reports missing keys", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes("money-desk-feed.json")) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify({ generated_at: "2026-11-11T15:00:00.000Z", picks_today: [], pick_log: [], pnl: { realized: 1, unrealized: 0, total: 1, by_day: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    let statusCode = 0;
    let body = "";
    const res = {
      writeHead(status: number) {
        statusCode = status;
        return res;
      },
      end(payload?: string) {
        body = payload ?? "";
      },
    };
    const handled = await handleApi({ method: "GET", url: "/api/desk/trade-log" } as IncomingMessage, res as unknown as ServerResponse, {});
    assert.equal(handled, true);
    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body) as { kalshi: { error: string }; pnl: { source: string } };
    assert.equal(parsed.kalshi.error, KALSHI_KEYS_MISSING);
    assert.equal(parsed.pnl.source, "feed");
    assert.equal(body.includes("BEGIN"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("the trade log module does not place orders", () => {
  const source = readFileSync(new URL("./trade-log.ts", import.meta.url), "utf8");
  assert.equal(source.includes("placeConfirmedOrder"), false);
  assert.equal(source.includes("/portfolio/events/orders"), false);
  assert.equal(source.includes("method: \"POST\""), false);
});

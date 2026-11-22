import { test, expect, type Page } from "@playwright/test";

const refreshedAt = "2026-11-11T15:30:00.000Z";

function view(patch: Record<string, unknown> = {}) {
  return {
    refreshedAt,
    feed: { generatedAt: "2026-11-11T15:00:00.000Z", error: null, host: "raw.githubusercontent.com" },
    kalshi: {
      configured: true,
      error: null,
      shards: [{ index: 2, label: "crypto and commodities", dollars: 9 }],
    },
    picksToday: [pick("KXBTCD-1", "PASS", "Crypto", "Bitcoin above strike", "2026-11-11T15:00:00.000Z")],
    positions: [{
      id: "KXBTCD-1|2",
      ticker: "KXBTCD-1",
      market: "Bitcoin above strike",
      tab: "Crypto",
      verdict: "PASS",
      side: "YES",
      contracts: 10,
      avgPrice: 0.4,
      mark: 0.55,
      unrealized: 1.5,
      shard: 2,
      shardLabel: "crypto and commodities",
      updated: refreshedAt,
    }],
    pnl: {
      source: "kalshi",
      realized: 5.8,
      unrealized: 1.5,
      total: 7.3,
      partial: false,
      unmarked: 0,
      note: "Realized is Kalshi settlement payout minus cost and fees.",
      byDay: [
        { date: "2026-11-11", realized: 5.8, unrealized: null, total: 5.8 },
        { date: "2026-11-10", realized: 1, unrealized: null, total: 1 },
      ],
    },
    pickLog: [
      pick("KXBTCD-1", "PASS", "Crypto", "Bitcoin above strike", "2026-11-11T15:00:00.000Z"),
      pick("KXHIGHNY-1", "FAIL", "Weather", "NYC high", "2026-11-10T18:00:00.000Z"),
    ],
    fills: [{
      id: "live-1",
      timestamp: refreshedAt,
      ticker: "KXBTCD-1",
      market: "Bitcoin above strike",
      tab: "Crypto",
      verdict: "PASS",
      side: "NO",
      action: "buy",
      price: 0.41,
      count: 2,
      fee: 0.07,
      shard: 2,
      shardLabel: "crypto and commodities",
      source: "kalshi",
    }],
    skipped: [{
      id: "skip-1",
      timestamp: "2026-11-11T14:00:00.000Z",
      tab: "Crypto",
      market: "Bitcoin above strike",
      ticker: "KXBTCD-1",
      side: "NO",
      verdict: "PASS",
      price: 0.4,
      count: 2,
      reason: "depth too thin",
    }],
    ...patch,
  };
}

function pick(ticker: string, verdict: string, tab: string, market: string, timestamp: string) {
  return {
    id: ticker,
    timestamp,
    tab,
    market,
    ticker,
    side: ticker.endsWith("1") && tab === "Weather" ? "YES" : "NO",
    price: 0.4,
    fairProb: 0.55,
    edgeCents: 3.2,
    stakeDollars: 10,
    stakeContracts: 4,
    verdict,
    closeTime: "2026-11-11T16:00:00.000Z",
    notes: verdict === "FAIL" ? "bucket" : "thin book",
  };
}

async function mockFeeds(page: Page) {
  await page.route("**/api/kraken/**", async (route) => {
    const ohlc = route.request().url().includes("OHLC");
    await route.fulfill({ json: { error: [], result: ohlc
      ? { XXBTZUSD: [[Math.floor(Date.now() / 1000), 1, 1, 1, 1, 1, 1, 1]], last: 1 }
      : { XXBTZUSD: { c: ["80100", "1"], b: ["80099", "1"], a: ["80101", "1"] } } } });
  });
  await page.route("**/api/kalshi/**", async (route) => {
    await route.fulfill({ json: route.request().url().includes("orderbook")
      ? { orderbook_fp: { yes_dollars: [["0.40", "1"]], no_dollars: [["0.55", "1"]] } }
      : { markets: [] } });
  });
}

test("trade log shows the sections, filters, money, and no order buttons", async ({ page }) => {
  await mockFeeds(page);
  await page.route("**/api/desk/trade-log", async (route) => {
    await route.fulfill({ json: view() });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Trade Log", exact: true }).click();
  const section = page.getByTestId("section-trade-log");
  await expect(section.getByRole("heading", { level: 2 })).toHaveText([
    "Today's picks",
    "Current positions",
    "Running P&L",
    "Full pick log",
    "Recent fills",
    "Skipped orders",
  ]);
  await expect(section.getByTestId("trade-pnl")).toContainText("+$5.80");
  await expect(section.getByTestId("trade-pnl")).toContainText("+$1.50");
  await expect(section.getByTestId("trade-pnl")).toContainText("+$7.30");
  await expect(section.getByTestId("trade-fills")).toContainText("Nov 11, 10:30 AM ET");
  await expect(section.getByTestId("trade-fills")).toContainText("$0.41");
  await expect(section.getByTestId("trade-today")).toContainText("55.0%");
  await expect(section.getByTestId("trade-today")).toContainText("3.2¢");
  await expect(section.getByTestId("trade-positions")).toContainText("crypto and commodities");
  await expect(section).not.toContainText("picks_today");
  await expect(section).not.toContainText("fill_id");
  await expect(section.getByRole("button", { name: /place|cancel/i })).toHaveCount(0);

  await section.getByTestId("trade-log-table").getByLabel("Full pick log verdict").selectOption("FAIL");
  await expect(section.getByTestId("trade-log-table").locator("tbody tr")).toHaveCount(1);
  await expect(section.getByTestId("trade-log-table")).toContainText("NYC high");
  await expect(section.getByTestId("trade-log-table")).not.toContainText("Bitcoin");
  await section.getByTestId("trade-log-table").getByLabel("Full pick log from").fill("2026-11-11");
  await expect(section.getByTestId("trade-log-table")).toContainText("Nothing matches these filters.");

  await section.getByTestId("trade-skipped").locator("summary").click();
  await expect(section.getByTestId("trade-skipped").locator("tbody")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  const accent = await page.getByRole("button", { name: "Trade Log", exact: true }).evaluate((el) => getComputedStyle(el).borderBottomColor);
  expect(accent).toBe("rgb(61, 154, 118)");
});

test("missing Kalshi keys stay visible and the feed P&L is labeled", async ({ page }) => {
  await mockFeeds(page);
  await page.route("**/api/desk/trade-log", async (route) => {
    await route.fulfill({ json: view({
      kalshi: { configured: false, error: "Kalshi keys not set", shards: [] },
      positions: [],
      fills: [],
      pnl: {
        source: "feed",
        realized: 2,
        unrealized: null,
        total: null,
        partial: false,
        unmarked: 0,
        note: "Kalshi keys are not set, so this P&L is the pick feed. It is not a live mark.",
        byDay: [],
      },
    }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Trade Log", exact: true }).click();
  await expect(page.getByTestId("kalshi-keys-missing")).toContainText("Kalshi keys not set");
  await expect(page.getByTestId("trade-positions")).toContainText("Kalshi keys not set");
  await expect(page.getByTestId("trade-pnl")).toContainText("not a live mark");
  await expect(page.getByTestId("section-trade-log").getByRole("button", { name: /place|cancel/i })).toHaveCount(0);
});

test("trade log refreshes from the button and again after five minutes", async ({ page }) => {
  await page.clock.install({ time: new Date(refreshedAt) });
  await mockFeeds(page);
  let hits = 0;
  await page.route("**/api/desk/trade-log", async (route) => {
    hits += 1;
    await route.fulfill({ json: view() });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Trade Log", exact: true }).click();
  await expect.poll(() => hits).toBe(1);
  await page.getByTestId("trade-log-refresh").click();
  await expect.poll(() => hits).toBe(2);
  await page.clock.fastForward(5 * 60 * 1000);
  await expect.poll(() => hits).toBeGreaterThan(2);
});

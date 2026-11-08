import { test, expect, type Page } from "@playwright/test";

function kraken(last: string) {
  return {
    error: [] as string[],
    result: { XXBTZUSD: { c: [last, "1"], b: [last, "1"], a: [last, "1"] } },
  };
}

function ohlc(last: number) {
  return {
    error: [] as string[],
    result: {
      XXBTZUSD: Array.from({ length: 30 }, (_, i) => [
        Math.floor(Date.now() / 1000) - (30 - i) * 60,
        last, last + 1, last - 1, last, last, 10, 5,
      ]),
      last: 1,
    },
  };
}

async function routeFeeds(
  page: Page,
  opts: {
    last?: string;
    krakenStatus?: number;
    open?: Record<string, unknown>[];
    unopened?: Record<string, unknown>[];
  },
) {
  await page.route("**/api/kraken/**", async (route) => {
    if (opts.krakenStatus) return route.fulfill({ status: opts.krakenStatus, body: "down" });
    const isOhlc = route.request().url().includes("OHLC");
    const last = Number(opts.last ?? "80100");
    await route.fulfill({ json: isOhlc ? ohlc(last) : kraken(opts.last ?? "80100") });
  });
  await page.route("**/api/kalshi/**", async (route) => {
    if (route.request().url().includes("orderbook")) {
      return route.fulfill({ json: { orderbook_fp: { yes_dollars: [["0.40", "2"]], no_dollars: [["0.55", "2"]] } } });
    }
    const unopened = route.request().url().includes("unopened");
    await route.fulfill({ json: { markets: unopened ? (opts.unopened ?? []) : (opts.open ?? []) } });
  });
}

test("no official strike shows no call, then an exact posted strike locks AT STRIKE", async ({ page }) => {
  const now = Date.now();
  const state = { strike: null as number | null };
  await page.route("**/api/kraken/**", async (route) => {
    const isOhlc = route.request().url().includes("OHLC");
    await route.fulfill({ json: isOhlc ? ohlc(80100) : kraken("80100.00") });
  });
  await page.route("**/api/kalshi/**", async (route) => {
    if (route.request().url().includes("orderbook")) {
      return route.fulfill({ json: { orderbook_fp: { yes_dollars: [["0.40", "1"]], no_dollars: [["0.55", "1"]] } } });
    }
    if (route.request().url().includes("unopened")) {
      return route.fulfill({ json: { markets: [{
        ticker: "NEXT-WINDOW", event_ticker: "NEXT", status: "initialized",
        open_time: new Date(now + 5 * 60_000).toISOString(),
        close_time: new Date(now + 20 * 60_000).toISOString(),
        ...(state.strike == null ? {} : { floor_strike: state.strike }),
        yes_ask_dollars: "0.0000", no_ask_dollars: "0.0000",
      }] } });
    }
    return route.fulfill({ json: { markets: [{
      ticker: "CURRENT-WINDOW", event_ticker: "CURRENT", status: "active",
      floor_strike: 79000,
      open_time: new Date(now - 2 * 60_000).toISOString(),
      close_time: new Date(now + 13 * 60_000).toISOString(),
      yes_ask_dollars: "0.40", no_ask_dollars: "0.60",
    }] } });
  });
  await page.goto("/");
  await expect(page.getByTestId("upcoming-call")).toHaveText("no call");
  await expect(page.getByTestId("upcoming-strike")).toHaveText("—");
  await expect(page.getByTestId("directional-call")).toHaveText("MISSED");
  await expect(page.getByRole("button", { name: "Lock this call" })).toHaveCount(0);
  state.strike = 80100;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("upcoming-call")).toHaveText("AT STRIKE");
  await expect(page.getByTestId("upcoming-strike")).toHaveText("$80,100.00");
  await expect(page.getByTestId("feed-status")).toContainText("LIVE FEED");
});

test("one change is allowed on the ten-minute tick and then the call stays locked", async ({ page }) => {
  const openMs = Date.parse("2026-11-07T00:00:00.000Z");
  const open = new Date(openMs).toISOString();
  const close = new Date(openMs + 15 * 60_000).toISOString();
  const ticker = "TEN-WINDOW";
  await page.clock.install({ time: openMs + 9 * 60_000 });
  await page.addInitScript(({ row }) => {
    if (!localStorage.getItem("moneyos.btc.journal.v1")) {
      localStorage.setItem("moneyos.btc.journal.v1", JSON.stringify([row]));
    }
  }, {
    row: {
      windowId: `${ticker}::${close}`,
      ticker, market: "15m", lockedCall: "UP", confidence: 62,
      lockedAt: openMs + 30_000, startPx: 80100, strike: 80000,
      closeTime: close, openTime: open, action: "WATCH", factors: ["Official strike"],
    },
  });
  await routeFeeds(page, {
    last: "80100",
    open: [{
      ticker, event_ticker: ticker, status: "active", floor_strike: 80000,
      open_time: open, close_time: close, yes_ask_dollars: "0.40", no_ask_dollars: "0.60",
    }],
  });
  await page.goto("/");
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await page.getByLabel("Revised call").selectOption("DOWN");
  await page.getByLabel("Change reason").fill("spot flipped");
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByTestId("revision-note")).toContainText("spot flipped");
  await page.getByLabel("Revised call").selectOption("AT STRIKE");
  await page.getByLabel("Change reason").fill("second try");
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByTestId("revision-refusal")).toContainText("Second change refused");
  await page.clock.fastForward(8_000);
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("revision-refusal")).toBeVisible();
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  await page.getByRole("button", { name: /^Journal/ }).click();
  await expect(page.locator("tbody tr")).toContainText("UP → DOWN");
  await expect(page.locator("tbody tr")).toContainText("spot flipped");
  await expect(page.locator("tbody tr")).toContainText("Second change refused");
});

test("an already-open window is MISSED and a dead feed is STALE, not live", async ({ page }) => {
  const now = Date.now();
  await routeFeeds(page, {
    last: "80100",
    open: [{
      ticker: "MISSED-WINDOW", event_ticker: "MISSED", status: "active", floor_strike: 79000,
      open_time: new Date(now - 2 * 60_000).toISOString(),
      close_time: new Date(now + 13 * 60_000).toISOString(),
      yes_ask_dollars: "0.40", no_ask_dollars: "0.60",
    }],
  });
  await page.goto("/");
  await expect(page.getByTestId("directional-call")).toHaveText("MISSED");
  await expect(page.getByRole("button", { name: "Missed" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Lock this call" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("directional-call")).toHaveText("MISSED");
  await page.getByRole("button", { name: /^Journal/ }).click();
  await expect(page.getByRole("cell", { name: "MISSED", exact: true })).toBeVisible();

  await page.unroute("**/api/kraken/**");
  await page.route("**/api/kraken/**", (route) => route.fulfill({ status: 503, body: "down" }));
  await page.getByRole("button", { name: "Desk" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("feed-status")).toContainText("STALE");
  await expect(page.getByTestId("feed-status")).not.toContainText("LIVE");
  await expect(page.locator(".metric-value.large")).toHaveText("—");
});

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

test("an equal spot and strike reads AT STRIKE", async ({ page }) => {
  const close = new Date(Date.now() + 10 * 60_000).toISOString();
  await routeFeeds(page, {
    last: "80000.00",
    open: [{ ticker: "AT-STRIKE", event_ticker: "AT", status: "active", floor_strike: 80000, close_time: close, yes_ask_dollars: "0.50", no_ask_dollars: "0.50" }],
  });
  await page.goto("/");
  await expect(page.getByTestId("directional-call")).toHaveText("AT STRIKE");
  await expect(page.getByTestId("feed-status")).toContainText("LIVE FEED");
});

test("the next window locks before it opens, and the official strike does not change that call", async ({ page }) => {
  const now = Date.now();
  const state = { posted: false };
  await page.route("**/api/kraken/**", async (route) => {
    const isOhlc = route.request().url().includes("OHLC");
    await route.fulfill({ json: isOhlc ? ohlc(80100) : kraken("80100") });
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
        ...(state.posted ? { floor_strike: 77000 } : {}),
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
  await expect(page.getByTestId("upcoming-call")).toHaveText("UP");
  await expect(page.getByTestId("directional-call")).toHaveText("MISSED");
  await expect(page.getByRole("button", { name: "Lock this call" })).toHaveCount(0);
  state.posted = true;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("upcoming-call")).toHaveText("UP");
  await expect(page.getByTestId("official-strike")).toContainText("$77,000.00");
});

test("one halfway change is kept and a second change stays refused", async ({ page }) => {
  const now = Date.now();
  const open = new Date(now - 8 * 60_000).toISOString();
  const close = new Date(now + 7 * 60_000).toISOString();
  const ticker = "HALF-WINDOW";
  await page.addInitScript(({ row }) => {
    if (!localStorage.getItem("moneyos.btc.journal.v1")) {
      localStorage.setItem("moneyos.btc.journal.v1", JSON.stringify([row]));
    }
  }, {
    row: {
      windowId: `${ticker}::${close}`,
      ticker, market: "15m", lockedCall: "UP", confidence: 62,
      lockedAt: now - 8 * 60_000 - 30_000, startPx: 80100, strike: 80000,
      closeTime: close, openTime: open, action: "WATCH", factors: ["Expected strike 80000.00 via posted-strike"],
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
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await page.getByLabel("Revised call").selectOption("DOWN");
  await page.getByLabel("Change reason").fill("spot flipped");
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByTestId("revision-note")).toContainText("spot flipped");
  await page.getByLabel("Revised call").selectOption("AT STRIKE");
  await page.getByLabel("Change reason").fill("second try");
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByTestId("revision-refusal")).toContainText("Second change refused");
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

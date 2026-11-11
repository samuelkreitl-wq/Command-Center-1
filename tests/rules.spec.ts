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

const OPEN_MS = Date.parse("2026-11-07T00:00:00.000Z");
const MINUTE_10 = OPEN_MS + 10 * 60_000;

async function openLockedDesk(page: Page) {
  const open = new Date(OPEN_MS).toISOString();
  const close = new Date(OPEN_MS + 15 * 60_000).toISOString();
  const ticker = "TEN-WINDOW";
  await page.clock.install({ time: OPEN_MS + 9 * 60_000 });
  await page.addInitScript(({ row }) => {
    if (!localStorage.getItem("moneyos.btc.journal.v1")) {
      localStorage.setItem("moneyos.btc.journal.v1", JSON.stringify([row]));
    }
  }, {
    row: {
      windowId: `${ticker}::${close}`,
      ticker, market: "15m", lockedCall: "UP", confidence: 62,
      lockedAt: OPEN_MS + 30_000, startPx: 80100, strike: 80000,
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
  await expect(page.getByTestId("feed-status")).toContainText("LIVE FEED");
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
}

async function saveChange(page: Page, call: string, reason: string) {
  await page.getByLabel("Revised call").selectOption(call);
  await page.getByLabel("Change reason").fill(reason);
  await page.getByRole("button", { name: "Save change" }).click();
}

async function journalCall(page: Page): Promise<{ lockedCall: string; revisedCall?: string; revision?: { reason: string }; revisionRefusal?: { attempted: string } }> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("moneyos.btc.journal.v1");
    const rows = raw ? JSON.parse(raw) as Array<{ lockedCall: string; revisedCall?: string; revision?: { reason: string }; revisionRefusal?: { attempted: string } }> : [];
    return rows[0];
  });
}

test("a change at 10:00 is saved, and a second change at 10:30 is refused", async ({ page }) => {
  await openLockedDesk(page);
  await page.clock.pauseAt(MINUTE_10);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  expect(await page.evaluate(() => Date.now())).toBe(MINUTE_10);
  await saveChange(page, "DOWN", "at 10:00");
  await expect(page.getByTestId("revision-note")).toContainText("at 10:00");
  await page.clock.pauseAt(MINUTE_10 + 8_000);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await page.clock.pauseAt(MINUTE_10 + 30_000);
  expect(await page.evaluate(() => Date.now())).toBe(MINUTE_10 + 30_000);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await saveChange(page, "AT STRIKE", "second try");
  await expect(page.getByTestId("revision-refusal")).toContainText("Second change refused");
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  const row = await journalCall(page);
  expect(row.lockedCall).toBe("UP");
  expect(row.revisedCall).toBe("DOWN");
  expect(row.revision?.reason).toBe("at 10:00");
  expect(row.revisionRefusal?.attempted).toBe("AT STRIKE");
  await page.reload();
  await expect(page.getByTestId("revision-refusal")).toBeVisible();
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  await page.getByRole("button", { name: /^Journal/ }).click();
  await expect(page.locator("tbody tr")).toContainText("UP → DOWN");
  await expect(page.locator("tbody tr")).toContainText("at 10:00");
  await expect(page.locator("tbody tr")).toContainText("Second change refused");
});

test("a first change at 10:30 is allowed", async ({ page }) => {
  await openLockedDesk(page);
  await page.clock.pauseAt(MINUTE_10 + 30_000);
  expect(await page.evaluate(() => Date.now())).toBe(MINUTE_10 + 30_000);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await saveChange(page, "DOWN", "at 10:30");
  await expect(page.getByTestId("revision-note")).toContainText("at 10:30");
  const row = await journalCall(page);
  expect(row.revisedCall).toBe("DOWN");
  expect(row.revision?.reason).toBe("at 10:30");
  expect(row.revisionRefusal).toBeUndefined();
});

test("a change at 10:59.9 is allowed and the form closes once the clock reaches 11:00", async ({ page }) => {
  await openLockedDesk(page);
  await page.clock.pauseAt(MINUTE_10 + 59_900);
  expect(await page.evaluate(() => Date.now())).toBe(MINUTE_10 + 59_900);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await saveChange(page, "DOWN", "at 10:59.9");
  await expect(page.getByTestId("revision-note")).toContainText("at 10:59.9");
  await page.clock.runFor(1_000);
  expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(OPEN_MS + 11 * 60_000);
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  const row = await journalCall(page);
  expect(row.lockedCall).toBe("UP");
  expect(row.revisedCall).toBe("DOWN");
  expect(row.revision?.reason).toBe("at 10:59.9");
  expect(row.revisionRefusal).toBeUndefined();
  await page.getByRole("button", { name: /^Journal/ }).click();
  await expect(page.locator("tbody tr")).toContainText("UP → DOWN");
  await expect(page.locator("tbody tr")).toContainText("at 10:59.9");
});

test("at 11:00 the call is locked and a change cannot be submitted", async ({ page }) => {
  await openLockedDesk(page);
  await page.clock.pauseAt(MINUTE_10 + 59_900);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await page.clock.runFor(1_000);
  expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(OPEN_MS + 11 * 60_000);
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save change" })).toHaveCount(0);
  const row = await journalCall(page);
  expect(row.lockedCall).toBe("UP");
  expect(row.revisedCall).toBeUndefined();
  expect(row.revision).toBeUndefined();
  expect(row.revisionRefusal).toBeUndefined();
});

test("a stale spot during minute 10 cannot change the call", async ({ page }) => {
  await openLockedDesk(page);
  await page.clock.pauseAt(MINUTE_10 + 15_000);
  await expect(page.getByTestId("revise-form")).toBeVisible();
  await page.unroute("**/api/kraken/**");
  await page.route("**/api/kraken/**", (route) => route.fulfill({ status: 503, body: "down" }));
  await page.clock.pauseAt(MINUTE_10 + 15_000 + 35_000);
  expect(await page.evaluate(() => Date.now())).toBe(MINUTE_10 + 50_000);
  await expect(page.getByTestId("feed-status")).toContainText("STALE");
  await expect(page.getByTestId("feed-status")).not.toContainText("LIVE");
  await expect(page.getByTestId("revise-form")).toHaveCount(0);
  const row = await journalCall(page);
  expect(row.lockedCall).toBe("UP");
  expect(row.revisedCall).toBeUndefined();
  expect(row.revision).toBeUndefined();
  expect(row.revisionRefusal).toBeUndefined();
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

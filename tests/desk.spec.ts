import { test, expect, type Page } from "@playwright/test";

// Explicit test fixtures only: the running application never uses sample data.
async function mockFeeds(page: Page, outage = false, opensInMs = -60000) {
  const open = Date.now() + opensInMs;
  const openTime = new Date(open).toISOString();
  const close = new Date(open + 900000).toISOString();
  await page.route("**/api/kalshi/**", async (route) => {
    const book = route.request().url().includes("orderbook");
    await route.fulfill({ json: book
      ? { orderbook_fp: { yes_dollars: [["0.39", "2"]], no_dollars: [["0.59", "2"]] } }
      : { markets: [{ ticker: "TEST-BTC15M", event_ticker: "TEST", status: "active",
          floor_strike: 80000, open_time: openTime, close_time: close, yes_ask_dollars: "0.41", no_ask_dollars: "0.61" }] },
    });
  });
  await page.route("**/api/kraken/**", async (route) => {
    if (outage) return route.fulfill({ status: 503, body: "Test feed outage" });
    const ohlc = route.request().url().includes("OHLC");
    await route.fulfill({ json: { error: [], result: ohlc
      ? { XXBTZUSD: Array.from({ length: 30 }, (_, i) => [
          Math.floor(Date.now() / 1000) - (30 - i) * 60,
          80050 + i, 80060 + i, 80040 + i, 80055 + i, 80050 + i, 10, 5,
        ]), last: 1 }
      : { XXBTZUSD: { c: ["80100", "1"], b: ["80099", "1"], a: ["80101", "1"] } },
    } });
  });
}

test("lock, paper entry, reference and records survive refresh", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await mockFeeds(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Short-window desk" })).toBeVisible();
  await expect(page.locator(".lock-strip button")).toBeEnabled();
  await page.locator(".lock-strip button").click();
  await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Record revision" })).toBeVisible();
  const openingCall = (await page.locator(".lock-copy strong").first().textContent()) ?? "";
  await page.getByLabel("Revised direction").selectOption(openingCall.includes("UP") ? "DOWN" : "UP");
  await page.getByLabel("Reason for call revision").fill("Trend reversed after fresh bars");
  await page.getByRole("button", { name: "Record revision" }).click();
  await expect(page.locator(".revision-history li")).toHaveCount(1);
  await expect(page.locator(".revision-history")).toContainText("Trend reversed after fresh bars");
  await page.getByLabel("Custom reference price").fill("79900");
  await page.getByRole("button", { name: "Save level" }).click();
  await expect(page.locator(".reference-value")).toHaveText("$79,900.00");
  await page.getByLabel("Contracts", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Record paper YES" }).click();
  await page.getByRole("button", { name: /^Paper trade log/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("Open");
  await page.reload();
  await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeDisabled();
  await expect(page.locator(".reference-value")).toHaveText("$79,900.00");
  await page.getByRole("button", { name: /^Journal/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("UP");
  await expect(page.locator("tbody tr")).toContainText("Trend reversed after fresh bars");
  await page.getByRole("button", { name: /^Paper trade log/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

test("manual settlement of an expired miss blocks new paper entries", async ({ page }) => {
  await mockFeeds(page);
  await page.goto("/");
  await page.evaluate(() => {
    const closeTime = new Date(Date.now() - 60000).toISOString();
    const windowId = `EXPIRED::${closeTime}`;
    localStorage.setItem("moneyos.btc.journal.v1", JSON.stringify([{
      windowId, ticker: "EXPIRED", market: "15m", lockedCall: "UP", confidence: 70,
      lockedAt: Date.now() - 900000, startPx: 80100, strike: 80000,
      closeTime, action: "WATCH", factors: [],
    }]));
    localStorage.setItem("moneyos.btc.trades.v1", JSON.stringify([{
      id: "test-paper", windowId, ticker: "EXPIRED", market: "15m", mode: "paper",
      side: "YES", size: 2, entry: 0.4, strike: 80000, openedAt: Date.now() - 900000,
    }]));
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Record paper YES" })).toBeEnabled();
  await page.getByLabel("Historical window").selectOption({ index: 1 });
  await page.getByLabel("Final price", { exact: true }).fill("79900");
  await page.getByRole("button", { name: "Settle manually" }).click();
  await expect(page.getByRole("button", { name: "Record paper YES" })).toBeDisabled();
  await expect(page.locator(".evidence-meta")).toContainText("0 correct calls");
  await page.getByRole("button", { name: /^Paper trade log/ }).click();
  await expect(page.locator("tbody tr")).toContainText("Settled");
  await expect(page.locator("tbody tr")).toContainText("-0.80");
});

test("feed errors disable actions without replacing prices with fake values", async ({ page }) => {
  await mockFeeds(page, true);
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Kraken HTTP 503");
  await expect(page.getByRole("button", { name: "Record paper YES" })).toBeDisabled();
  await expect(page.locator(".lock-strip button")).toBeDisabled();
  await expect(page.locator(".metric-value.large")).toHaveText("—");
});

test("phone layout fits the viewport and can open its journal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockFeeds(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Record paper YES" })).toBeEnabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: /^Journal/ }).click();
  await expect(page.getByText("No directional calls have been locked yet.")).toBeVisible();
});

test("a future contract locks automatically in the 30-second pre-open window", async ({ page }) => {
  await mockFeeds(page, false, 25_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeDisabled({ timeout: 7000 });
  await expect(page.locator(".lock-copy")).toContainText("PRE OPEN");
  await page.getByRole("button", { name: /^Journal/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("PRE OPEN");
});

test("a future call waits until its pre-open lock window", async ({ page }) => {
  test.setTimeout(45000);
  await mockFeeds(page, false, 60000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Scheduled" })).toBeDisabled();
  await expect(page.locator(".lock-copy")).toContainText("Keep the desk open");
  await page.waitForTimeout(32000);
  await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeDisabled({ timeout: 5000 });
});

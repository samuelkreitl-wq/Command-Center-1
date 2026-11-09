import { test, expect } from "@playwright/test";

test("the global BTC price updates and then shows STALE", async ({ page }) => {
  let price = "74530.12";
  let fail = false;
  await page.route("**/api/kraken/**", async (route) => {
    if (fail || !route.request().url().includes("Ticker")) {
      return route.fulfill({ status: 503, body: "down" });
    }
    await route.fulfill({ json: { error: [], result: { XXBTZUSD: { c: [price, "1"], b: [price, "1"], a: [price, "1"] } } } });
  });
  await page.route("**/api/kalshi/**", async (route) => {
    await route.fulfill({ json: { markets: [] } });
  });
  await page.goto("/");
  await expect(page.getByTestId("live-btc")).toContainText("$74,530.12");
  price = "74610.00";
  await page.waitForTimeout(5500);
  await expect(page.getByTestId("live-btc")).toContainText("$74,610.00");
  fail = true;
  await page.waitForTimeout(5500);
  await expect(page.getByTestId("live-btc-stale")).toBeVisible();
});

import { test, expect, type Page } from "@playwright/test";

async function silenceDesk(page: Page) {
  const close = new Date(Date.now() + 600000).toISOString();
  await page.route("**/api/kalshi/**", async (route) => {
    if (route.request().url().includes("orderbook")) {
      return route.fulfill({ json: { orderbook_fp: { yes_dollars: [["0.40", "2"]], no_dollars: [["0.55", "2"]] } } });
    }
    return route.fulfill({ json: { markets: [{ ticker: "TEST-BTC15M", event_ticker: "TEST", status: "active", floor_strike: 74000, close_time: close, open_time: new Date(Date.now() - 60000).toISOString(), yes_ask_dollars: "0.41", no_ask_dollars: "0.61" }] } });
  });
  await page.route("**/api/kraken/**", async (route) => {
    const ohlc = route.request().url().includes("OHLC");
    await route.fulfill({ json: { error: [], result: ohlc
      ? { XXBTZUSD: Array.from({ length: 30 }, (_, i) => [Math.floor(Date.now() / 1000) - (30 - i) * 60, 74500, 74510, 74490, 74500, 74500, 1, 1]), last: 1 }
      : { XXBTZUSD: { c: ["74530", "1"], b: ["74529", "1"], a: ["74531", "1"] } } } });
  });
}

async function reset(page: Page) {
  await page.request.post("http://127.0.0.1:5099/__reset");
  await page.request.post("/api/test/reset");
}

test("type a close, confirm once, then the same window is blocked and the next is allowed", async ({ page }) => {
  await silenceDesk(page);
  await reset(page);
  const fixture = await (await page.request.get("http://127.0.0.1:5099/__fixture")).json() as { windows: { utterance: string; ticker: string }[] };
  await page.goto("/");
  await page.getByRole("button", { name: "Spoken order" }).click();
  await page.getByTestId("utterance").fill(fixture.windows[0].utterance);
  await page.getByTestId("resolve").click();
  await expect(page.getByTestId("confirm-order")).toBeVisible();
  await expect(page.getByTestId("stop-line")).toBeVisible();
  await expect(page.getByTestId("forecast-adjust")).toContainText("Raw");
  await expect(page.getByTestId("forecast-adjust")).toContainText("Adjusted");
  await page.getByTestId("confirm-order").click();
  await expect(page.getByText(/sent once/)).toBeVisible();
  const after = await (await page.request.get("http://127.0.0.1:5099/__orders")).json() as { orders: { ticker: string }[] };
  expect(after.orders).toHaveLength(1);
  expect(after.orders[0].ticker).toBe(fixture.windows[0].ticker);
  await page.getByTestId("utterance").fill(fixture.windows[0].utterance);
  await page.getByTestId("resolve").click();
  await expect(page.getByTestId("position-block")).toContainText(`Position already held on ${fixture.windows[0].ticker}`);
  await expect(page.getByTestId("confirm-order")).toHaveCount(0);
  await page.getByTestId("utterance").fill(fixture.windows[1].utterance);
  await page.getByTestId("resolve").click();
  await expect(page.getByTestId("confirm-order")).toBeVisible();
  const still = await (await page.request.get("http://127.0.0.1:5099/__orders")).json() as { orders: unknown[] };
  expect(still.orders).toHaveLength(1);
});

test("speech can propose and cancel without placing an order", async ({ page }) => {
  await page.addInitScript(() => {
    class Fake {
      lang = "en-US";
      interimResults = false;
      onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        const text = (window as unknown as { __speechUtterance?: string }).__speechUtterance || "";
        this.onresult?.({ results: [[{ transcript: text }]] });
        this.onend?.();
      }
    }
    (window as unknown as { __deskSpeech: unknown }).__deskSpeech = Fake;
  });
  await silenceDesk(page);
  await reset(page);
  const fixture = await (await page.request.get("http://127.0.0.1:5099/__fixture")).json() as { windows: { utterance: string }[] };
  await page.goto("/");
  await page.evaluate((utterance) => { (window as unknown as { __speechUtterance?: string }).__speechUtterance = utterance; }, fixture.windows[0].utterance);
  await page.getByRole("button", { name: "Spoken order" }).click();
  await page.getByTestId("mic").click();
  await expect(page.getByTestId("confirm-order")).toBeVisible();
  await page.getByTestId("cancel-order").click();
  await expect(page.getByText("Cancelled. No order was sent.")).toBeVisible();
  const after = await (await page.request.get("http://127.0.0.1:5099/__orders")).json() as { orders: unknown[] };
  expect(after.orders).toHaveLength(0);
});

test("a 3 day question returns a scenario and places nothing", async ({ page }) => {
  await silenceDesk(page);
  await reset(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Spoken order" }).click();
  await page.getByTestId("utterance").fill("what's Bitcoin in 3 days?");
  await page.getByTestId("resolve").click();
  await expect(page.getByTestId("horizon-result")).toContainText("SCENARIO");
  await expect(page.getByTestId("confirm-order")).toHaveCount(0);
  const after = await (await page.request.get("http://127.0.0.1:5099/__orders")).json() as { orders: unknown[] };
  expect(after.orders).toHaveLength(0);
});

test("health reports the trader", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.kalshiEnv).toBe("demo");
  expect(["paper", "live", "both"]).toContain(body.mode);
});

import { test, expect } from "@playwright/test";

test("the recorded loss is in the paper book and the learning panel", async ({ page, request }) => {
  const trades = await (await request.get("/api/paper/trades")).json() as { trades: { id: string; kind: string; ticker: string; source?: string }[] };
  const recorded = trades.trades.filter((row) => row.kind === "entry" && row.ticker === "KXBTCD-26NOV0902-T74299.99");
  expect(recorded).toHaveLength(1);
  expect(recorded[0].source).toBe("recorded");
  const again = await (await request.get("/api/paper/trades")).json() as { trades: { id: string }[] };
  expect(again.trades.filter((row) => row.id === recorded[0].id)).toHaveLength(1);
  const stats = await (await request.get("/api/paper/stats")).json() as { settled: number; losses: number };
  expect(stats.settled).toBeGreaterThanOrEqual(1);
  expect(stats.losses).toBeGreaterThanOrEqual(1);
  const learning = await (await request.get("/api/learning/stats")).json() as { overall: { n: number; hits: number }; recorded: number };
  expect(learning.recorded).toBeGreaterThanOrEqual(1);
  expect(learning.overall.n).toBeGreaterThanOrEqual(1);
  expect(learning.overall.hits).toBeLessThan(learning.overall.n);
  await page.goto("/");
  await page.getByRole("button", { name: "Paper trader" }).click();
  await expect(page.getByTestId("learning-panel")).toContainText("Overall");
  await expect(page.getByTestId("learning-panel")).toContainText("minute tape");
});
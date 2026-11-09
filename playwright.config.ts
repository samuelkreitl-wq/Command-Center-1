import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const chrome = existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined;

export default defineConfig({
  testDir: "./tests",
  outputDir: "./generated-artifacts/test-results",
  globalSetup: "./tests/global-setup.ts",
  reporter: "list",
  workers: 1,
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5000",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MODE: "both",
      TRADING_ENABLED: "true",
      KALSHI_ENV: "demo",
      KALSHI_API_BASE: "http://127.0.0.1:5099/trade-api/v2",
      KRAKEN_API_BASE: "http://127.0.0.1:5099/0/public",
      KALSHI_API_KEY_ID: "playwright-key",
      KALSHI_PRIVATE_KEY_PATH: "data/playwright-kalshi.pem",
      DESK_STORE: "jsonl",
      DESK_JSONL_DIR: "data/playwright-jsonl",
      DESK_TEST_RESET: "1",
      PAPER_POLL_MS: "60000",
    },
  },
  use: {
    baseURL: "http://127.0.0.1:5000",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? chrome ?? (existsSync("/repl/tools/bin/chromium") ? "/repl/tools/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    },
  },
});

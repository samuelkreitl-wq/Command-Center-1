import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./generated-artifacts/test-results",
  reporter: "list",
  workers: 1,
  use: {
    baseURL: process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ??
        (existsSync("/repl/tools/bin/chromium") ? "/repl/tools/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    },
  },
});


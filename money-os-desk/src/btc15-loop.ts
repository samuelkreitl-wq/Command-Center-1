/**
 * Unattended KXBTC15M call runner.
 * Public Kraken and Kalshi reads only. No API keys. No order paths.
 *
 *   npm run btc15:loop
 *
 * Ledger file: money-os-desk/data/btc15-calls.jsonl
 * Override with BTC15_LEDGER=/absolute/path.jsonl
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOOP_TICK_MS,
  formatActionLine,
  nextTickDelay,
} from "./lib/call-lifecycle";
import { advanceListedBtc15 } from "./lib/feeds";
import { openJsonlLedger } from "./lib/jsonl-ledger";

const ledgerPath =
  process.env.BTC15_LEDGER ??
  join(dirname(fileURLToPath(import.meta.url)), "../data/btc15-calls.jsonl");

const ledger = openJsonlLedger(ledgerPath);
let stopped = false;

function requestStop(): void {
  stopped = true;
}

process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

function sleep(ms: number): Promise<void> {
  if (ms <= 0 || stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    }
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

async function main(): Promise<void> {
  let delay = LOOP_TICK_MS;
  while (!stopped) {
    const started = Date.now();
    let hadError = false;
    try {
      const { actions, errors } = await advanceListedBtc15(ledger, started);
      for (const action of actions) {
        process.stdout.write(`${formatActionLine(action)}\n`);
      }
      if (errors.length > 0) {
        hadError = true;
        process.stderr.write(`${new Date().toISOString()} ERROR ${errors.join("; ")}\n`);
      }
    } catch (error) {
      hadError = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${new Date().toISOString()} ERROR ${message}\n`);
    }
    if (stopped) break;
    delay = nextTickDelay(delay, hadError);
    const elapsed = Date.now() - started;
    const wait = hadError ? delay : Math.max(0, delay - elapsed);
    await sleep(wait);
  }
}

void main().then(() => {
  process.exit(0);
});

/**
 * Money OS Desk — local dev harness.
 *
 * Runs the library's own live feed loop (Kraken spot + 1m OHLC, Kalshi KXBTC15M
 * contract, Crypto Fear & Greed) through `buildSnapshot` and serves the latest
 * bundle to a small read-only page. Server-side fetching keeps the public feed
 * calls out of browser CORS territory.
 *
 * Read-only: it renders the desk snapshot. It does not lock or place paper trades
 * (journal.ts is localStorage-backed, so the library's journal is inert here).
 */

import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFeedLoop, type FeedBundle } from "../money-os-desk/src/lib/feeds";
import type { MarketWindow } from "../money-os-desk/src/lib/types";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 8000);
const MARKET: MarketWindow = process.env.MARKET === "5m" ? "5m" : "15m";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "index.html");

let latest: FeedBundle | null = null;
let polls = 0;

startFeedLoop(
  (bundle) => {
    latest = bundle;
    polls += 1;
    const s = bundle.snapshot;
    console.log(
      `[desk] poll #${polls} ${s.contract?.ticker ?? "no-contract"} ` +
        `spot=${s.spot?.price ?? "-"} strike=${s.contract?.strike ?? "-"} ` +
        `call=${s.liveCall ?? "-"} conf=${s.confidence} action=${s.action}` +
        (bundle.errors.length ? ` errors=${bundle.errors.join(" | ")}` : "")
    );
  },
  { market: MARKET, intervalMs: POLL_INTERVAL_MS }
);

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/api/snapshot") {
    send(res, 200, "application/json", JSON.stringify({ polls, latest }));
    return;
  }

  if (path === "/" || path === "/index.html") {
    try {
      send(res, 200, "text/html; charset=utf-8", await readFile(PAGE, "utf8"));
    } catch (e) {
      send(res, 500, "text/plain; charset=utf-8", `page missing: ${String(e)}`);
    }
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "not found");
});

server.listen(PORT, HOST, () => {
  console.log(
    `[desk] harness on http://${HOST}:${PORT} — market=${MARKET}, polling every ${POLL_INTERVAL_MS}ms`
  );
});

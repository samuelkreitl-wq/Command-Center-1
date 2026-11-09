import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { zonedParts, zonedTimeToUtc } from "../money-os-desk/src/lib/et-time";
import { closeSuffix } from "../money-os-desk/src/lib/window-resolve";

type Window = { ticker: string; close: string; open: string; suffix: string; utterance: string };

let cache: { at: number; windows: Window[] } | null = null;
const orders: unknown[] = [];
const positions: { ticker: string; position: number; market_exposure_dollars: string }[] = [];

function windows(now = Date.now()): Window[] {
  if (cache && now - cache.at < 120_000) return cache.windows;
  const built: Window[] = [];
  for (let skip = 0; skip < 2; skip++) built.push(quarter(now, skip));
  cache = { at: now, windows: built };
  return built;
}

function quarter(now: number, skip: number): Window {
  const parts = zonedParts(new Date(now));
  let minutes = parts.hour * 60 + parts.minute + 4;
  const rem = minutes % 15;
  if (rem !== 0) minutes += 15 - rem;
  minutes += skip * 15;
  const hour24 = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const close = zonedTimeToUtc(parts.year, parts.month, parts.day, hour24, minute);
  const suffix = closeSuffix(hour24, minute);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 < 12 ? "am" : "pm";
  return {
    ticker: `KXBTC15M-TEST-${suffix}`,
    close: close.toISOString(),
    open: new Date(close.getTime() - 15 * 60_000).toISOString(),
    suffix,
    utterance: `74400 ${hour12}:${String(minute).padStart(2, "0")}${ampm}`,
  };
}

function candles(interval: number) {
  const now = Math.floor(Date.now() / 1000);
  const count = interval >= 1440 ? 180 : 60;
  const step = interval * 60;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const price = 74000 + i * (interval >= 1440 ? 8 : 2) + (i % 2 ? 15 : -10);
    rows.push([now - (count - i) * step, price, price + 5, price - 5, price, price, 1, 1]);
  }
  return rows;
}

function send(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function market(window: Window) {
  return {
    ticker: window.ticker,
    event_ticker: window.ticker,
    status: "active",
    floor_strike: 74000,
    close_time: window.close,
    open_time: window.open,
    yes_ask_dollars: "0.4500",
    yes_bid_dollars: "0.4000",
    no_ask_dollars: "0.6000",
    no_bid_dollars: "0.5500",
    title: "BTC 15m",
  };
}

export function startMock(port = 5099) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/__reset") {
      orders.length = 0;
      positions.length = 0;
      cache = null;
      return send(res, { ok: true });
    }
    if (url.pathname === "/__orders") return send(res, { orders, positions });
    if (url.pathname === "/__fixture") return send(res, { windows: windows() });
    if (url.pathname.endsWith("/Ticker")) {
      return send(res, { error: [], result: { XXBTZUSD: { c: ["74530.00", "1"], b: ["74529", "1"], a: ["74531", "1"] } } });
    }
    if (url.pathname.endsWith("/OHLC")) {
      const interval = Number(url.searchParams.get("interval") || "1");
      return send(res, { error: [], result: { XXBTZUSD: candles(interval), last: 1 } });
    }
    if (url.pathname.endsWith("/markets") && req.method === "GET") {
      const series = url.searchParams.get("series_ticker");
      const list = series === "KXBTC15M" ? windows().map(market) : series === "KXBTCD" ? [{
        ticker: "KXBTCD-TEST-75000", status: "active", floor_strike: 75000, close_time: windows()[0].close, open_time: windows()[0].open,
        yes_ask_dollars: "0.4000", no_ask_dollars: "0.6000", yes_bid_dollars: "0.3900", no_bid_dollars: "0.5900", title: "BTC above 75000",
      }] : [];
      return send(res, { markets: list });
    }
    if (url.pathname.includes("/orderbook")) {
      return send(res, { orderbook_fp: { yes_dollars: [["0.40", "2"]], no_dollars: [["0.55", "2"]] } });
    }
    if (url.pathname.endsWith("/portfolio/positions")) return send(res, { market_positions: positions });
    if (url.pathname.endsWith("/portfolio/orders") && req.method === "GET") return send(res, { orders });
    if (url.pathname.endsWith("/portfolio/orders") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { ticker?: string; side?: string; count?: number; yes_price_dollars?: string };
        orders.push(body);
        positions.push({ ticker: body.ticker || "", position: body.side === "no" ? -Number(body.count || 1) : Number(body.count || 1), market_exposure_dollars: body.yes_price_dollars || "0.45" });
        send(res, { order: { order_id: `ord-${orders.length}`, status: "resting" } });
      });
      return;
    }
    send(res, { ok: false }, 404);
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((done) => server.close(() => done())),
    }));
  });
}

if (process.argv[1]?.endsWith("mock-exchange.ts")) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  mkdirSync("data", { recursive: true });
  writeFileSync("data/playwright-kalshi.pem", privateKey.export({ type: "pkcs8", format: "pem" }));
  startMock().then(() => console.log("mock kalshi on 5099"));
}

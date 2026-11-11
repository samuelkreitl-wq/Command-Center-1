import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { findArbs } from "./arb.js";
import { handleChat } from "./chat.js";
import { fetchMarket, fetchOrderbook } from "./kalshi-public.js";
import { keysConfigured } from "./kalshi-private.js";
import { passwordConfigured } from "./password.js";
import { placeConfirmedOrder, previewOrder, type OrderRequest } from "./orders.js";
import { runScan, serverEdgeFor } from "./scan.js";
import { startHourlyScanner } from "./scheduler.js";
import { deskRoot, readHistory, readOrderLog } from "./store.js";
import { readFileSync } from "node:fs";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 5000);
const DIST = path.join(process.cwd(), "dist");

type Body = Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("Body too large");
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Body;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  if (!url.pathname.startsWith("/api/desk")) return false;
  try {
    if (req.method === "GET" && url.pathname === "/api/desk/status") {
      send(res, 200, {
        kalshiKey: keysConfigured(env),
        approvalPassword: passwordConfigured(env.MONEY_DESK_APPROVAL_PASSWORD),
        xai: Boolean(env.XAI_API_KEY),
        odds: Boolean(env.ODDS_API_KEY),
        weatherCompany: Boolean(env.WEATHER_COMPANY_API_KEY),
        assumedBankroll: Boolean(env.MONEY_DESK_ASSUMED_BANKROLL),
        scanner: "hourly-et",
      });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/desk/scan/latest") {
      const file = path.join(deskRoot(env), "latest.json");
      if (!existsSync(file)) {
        send(res, 200, { pass: [], watch: [], saved: [], coverage: [], errors: [], empty: true });
        return true;
      }
      const report = JSON.parse(readFileSync(file, "utf8")) as { finishedAt?: string };
      const age = report.finishedAt ? Date.now() - Date.parse(report.finishedAt) : Number.POSITIVE_INFINITY;
      send(res, 200, { ...report, stale: age > 70 * 60_000 });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/desk/scan/history") {
      send(res, 200, { columns: ["timestamp_et", "tab", "market_title", "ticker", "side", "price", "fair_prob", "edge_cents_after_fees", "stake_suggestion_contracts", "stake_suggestion_dollars", "verdict", "reality_check_verdict", "reality_check_path", "shown_to_samuel", "close_time_et", "record_path"], rows: readHistory(deskRoot(env)) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/desk/scan") {
      const report = await runScan({ env });
      send(res, 200, report);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/desk/arb") {
      send(res, 200, await findArbs(env));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/desk/chat") {
      const body = await readBody(req);
      const result = await handleChat({ message: String(body.message ?? ""), env });
      send(res, 200, result);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/desk/orders/log") {
      send(res, 200, { orders: readOrderLog(deskRoot(env)) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/desk/orders/preview") {
      const body = await readBody(req);
      const preview = await previewOrder({
        ticker: String(body.ticker ?? ""),
        side: body.side === "NO" ? "NO" : "YES",
        count: Number(body.count),
        price: Number(body.price),
      }, { env, fetchMarket, fetchBook: fetchOrderbook });
      send(res, 200, preview);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/desk/orders") {
      const body = await readBody(req);
      const request: OrderRequest = {
        source: "user-confirm",
        confirm: body.confirm,
        password: body.password,
        ticker: body.ticker,
        side: body.side,
        count: body.count,
        price: body.price,
        acknowledgedPrice: body.acknowledgedPrice,
        acknowledgedEdge: body.acknowledgedEdge,
        serverEdge: null,
      };
      const result = await placeConfirmedOrder(request, {
        env,
        edgeFor: (ticker, side, price, count) => serverEdgeFor(ticker, side, price, count),
      });
      send(res, result.ok ? 200 : result.status, result);
      return true;
    }
    send(res, 404, { error: "Unknown desk route" });
    return true;
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
    return true;
  }
}

async function proxyPublic(req: IncomingMessage, res: ServerResponse, prefix: string, target: string): Promise<void> {
  const incoming = new URL(req.url || "/", "http://localhost");
  const upstream = new URL(incoming.pathname.replace(prefix, target) + incoming.search);
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("User-Agent", "money-os-desk/1.0");
  const response = await fetch(upstream, { headers, signal: AbortSignal.timeout(15000) });
  res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || "application/json" });
  if (response.body) Readable.fromWeb(response.body as import("stream/web").ReadableStream).pipe(res);
  else res.end();
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://localhost");
  const requested = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  const file = requested.startsWith(DIST) && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : path.join(DIST, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("Build the desk first: npm run build");
    return;
  }
  const ext = path.extname(file);
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export function start(env: Record<string, string | undefined> = process.env): void {
  const production = env.NODE_ENV === "production";
  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void } | null = null;
  const server = createServer(async (req, res) => {
    try {
      const url = req.url || "/";
      if (url.startsWith("/api/desk")) {
        await handleApi(req, res, env);
        return;
      }
      if (url.startsWith("/api/kalshi")) {
        await proxyPublic(req, res, "/api/kalshi", "https://api.elections.kalshi.com/trade-api/v2");
        return;
      }
      if (url.startsWith("/api/kraken")) {
        await proxyPublic(req, res, "/api/kraken", "https://api.kraken.com/0/public");
        return;
      }
      if (!production && vite) {
        vite.middlewares(req, res, () => {
          res.writeHead(404).end();
        });
        return;
      }
      serveStatic(req, res);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "text/plain" }).end(error instanceof Error ? error.message : "proxy error");
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`Money desk listening on ${HOST}:${PORT}`);
  });
  if (!production) {
    void import("vite").then(async ({ createServer: createVite }) => {
      const instance = await createVite({
        root: path.join(process.cwd(), "money-os-desk"),
        server: { middlewareMode: true, hmr: { server } },
        appType: "spa",
      });
      vite = instance;
    }).catch((error) => {
      console.error("Vite middleware failed", error);
    });
  }
  const boot = path.join(deskRoot(env), "latest.json");
  let age = Number.POSITIVE_INFINITY;
  if (existsSync(boot)) {
    try {
      const report = JSON.parse(readFileSync(boot, "utf8")) as { finishedAt?: string };
      if (report.finishedAt) age = Date.now() - Date.parse(report.finishedAt);
    } catch {
      age = Number.POSITIVE_INFINITY;
    }
  }
  if (age > 55 * 60_000) {
    setTimeout(() => {
      void runScan({ env }).catch((error) => console.error("boot scan failed", error instanceof Error ? error.message : error));
    }, 2000);
  }
  startHourlyScanner(() => runScan({ env }).then(() => undefined));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) start();

import { createReadStream, existsSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRuntime, type DeskRuntime } from "./runtime";
import { openStore } from "./store";
import { createResilientLoop } from "./loop";
import { readConfig } from "./config";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let runtimePromise: Promise<DeskRuntime> | null = null;
let backgroundStarted = false;

export function getRuntime(): Promise<DeskRuntime> {
  if (!runtimePromise) {
    runtimePromise = openStore().then((store) => createRuntime({ store }));
  }
  return runtimePromise;
}

export function startBackground() {
  if (backgroundStarted) return;
  backgroundStarted = true;
  void getRuntime().then((runtime) => {
    const config = readConfig();
    const paper = createResilientLoop({
      intervalMs: config.paperPollMs,
      tick: () => runtime.paperTick(),
      onError: (error) => console.error("paper tick failed:", error instanceof Error ? error.message : error),
    });
    const horizon = createResilientLoop({
      intervalMs: config.horizonRefreshMs,
      tick: async () => {
        await runtime.horizonView(true);
        await runtime.safetyStatus();
      },
      onError: (error) => console.error("scenario refresh failed:", error instanceof Error ? error.message : error),
    });
    void paper.start();
    void horizon.start();
    const beat = setInterval(() => runtime.markHeartbeat(), 5_000);
    beat.unref?.();
    console.log(`paper loop every ${config.paperPollMs}ms; scenario refresh every ${config.horizonRefreshMs}ms; mode ${config.mode}`);
  }).catch((error) => {
    backgroundStarted = false;
    console.error("desk runtime failed to start:", error instanceof Error ? error.message : error);
  });
}

export async function dispatch(req: IncomingMessage, res: ServerResponse, opts: { staticDir?: string; proxyPublic?: boolean } = {}): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  if (opts.proxyPublic && url.pathname.startsWith("/api/kraken")) {
    proxy(req, res, "https://api.kraken.com", "/api/kraken", "/0/public");
    return true;
  }
  if (opts.proxyPublic && url.pathname.startsWith("/api/kalshi")) {
    proxy(req, res, "https://api.elections.kalshi.com", "/api/kalshi", "/trade-api/v2");
    return true;
  }
  if (!url.pathname.startsWith("/api/")) {
    if (!opts.staticDir) return false;
    return serveStatic(opts.staticDir, url.pathname, res);
  }
  const runtime = await getRuntime();
  try {
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, await runtime.health());
    if (req.method === "GET" && url.pathname === "/api/paper/trades") return json(res, 200, { trades: await runtime.trades() });
    if (req.method === "GET" && url.pathname === "/api/paper/stats") return json(res, 200, await runtime.stats());
    if (req.method === "GET" && url.pathname === "/api/paper/export.csv") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.end(await runtime.csv());
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/safety-net") return json(res, 200, await runtime.safetyStatus());
    if (req.method === "GET" && url.pathname === "/api/forecast/short") {
      const view = await runtime.horizonView(url.searchParams.get("refresh") === "1");
      return json(res, 200, view);
    }
    if (req.method === "POST" && url.pathname === "/api/forecast/short") {
      const body = await readBody(req);
      const view = await runtime.horizonView(Boolean(body.force));
      return json(res, 200, view);
    }
    if (req.method === "GET" && url.pathname === "/api/trade/context") return json(res, 200, await runtime.contextView());
    if (req.method === "GET" && url.pathname === "/api/desk/mode") {
      return json(res, 200, { mode: await runtime.mode(), tradingEnabled: runtime.config.tradingEnabled, kalshiEnv: runtime.config.kalshiEnv, liveArmed: (await runtime.mode()) !== "paper" && runtime.config.tradingEnabled });
    }
    if (req.method === "POST" && url.pathname === "/api/desk/mode") {
      const body = await readBody(req);
      return json(res, 200, await runtime.setMode(String(body.mode || "")));
    }
    if (req.method === "POST" && url.pathname === "/api/trade/propose") {
      const body = await readBody(req);
      return json(res, 200, await runtime.propose(String(body.utterance || ""), body.count == null ? undefined : Number(body.count)));
    }
    if (req.method === "POST" && url.pathname === "/api/trade/execute") {
      const body = await readBody(req);
      return json(res, 200, await runtime.execute(body));
    }
    if (req.method === "POST" && url.pathname === "/api/trade/cancel") {
      const body = await readBody(req);
      return json(res, 200, runtime.cancel(String(body.proposalId || "")));
    }
    if (req.method === "POST" && url.pathname === "/api/test/reset" && readConfig().testReset) {
      await runtime.resetEphemeral();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, message: "Not found" });
  } catch (error) {
    console.error("api error:", error instanceof Error ? error.message : error);
    return json(res, 500, { ok: false, message: "The desk could not complete that request." });
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
  return true;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text) as Record<string, unknown>); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function proxy(req: IncomingMessage, res: ServerResponse, origin: string, strip: string, prefix: string) {
  const incoming = new URL(req.url || "/", "http://localhost");
  const dest = new URL(prefix + incoming.pathname.slice(strip.length) + incoming.search, origin);
  const headers = { ...req.headers, host: dest.host };
  delete headers["accept-encoding"];
  const lib = dest.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = lib(dest, { method: req.method, headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.statusCode = 502;
    res.end("upstream unavailable");
  });
  req.pipe(upstream);
}

function serveStatic(root: string, pathname: string, res: ServerResponse) {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe);
  if (!file.startsWith(root)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file)) {
    res.statusCode = 404;
    res.end("Not found");
    return true;
  }
  res.statusCode = 200;
  res.setHeader("content-type", TYPES[extname(file)] || "application/octet-stream");
  createReadStream(file).pipe(res);
  return true;
}

export function startServer(port = Number(process.env.PORT || 5000), host = "0.0.0.0") {
  startBackground();
  const root = join(process.cwd(), "dist");
  const server = createServer((req, res) => {
    void dispatch(req, res, { staticDir: root, proxyPublic: true });
  });
  return new Promise<{ port: number }>((resolve) => {
    server.listen(port, host, () => resolve({ port }));
  });
}

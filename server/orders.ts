import { randomUUID } from "node:crypto";
import { buildV2BuyOrder, MATERIAL_PRICE_MOVE, takerFeeDollars } from "../money-os-desk/src/lib/pricing.js";
import { fetchMarket, fetchOrderbook, marketAsk, type RawMarket } from "./kalshi-public.js";
import { keysConfigured, readShardCash, shardLabel, signedKalshi } from "./kalshi-private.js";
import { approvalPasswordOk, passwordConfigured } from "./password.js";
import { appendOrderLog, deskRoot } from "./store.js";

export type OrderRequest = {
  source: "user-confirm" | "schedule" | "chat" | "webhook";
  confirm: unknown;
  password: unknown;
  ticker: unknown;
  side: unknown;
  count: unknown;
  price: unknown;
  acknowledgedPrice: unknown;
  acknowledgedEdge: unknown;
  /** Computed on the server just before the gate. Never taken from the browser. */
  serverEdge: number | null;
};

export type OrderDeps = {
  env: Record<string, string | undefined>;
  now?: () => number;
  fetchMarket?: (ticker: string) => Promise<RawMarket | null>;
  edgeFor?: (ticker: string, side: "YES" | "NO", price: number, count: number) => Promise<number | null>;
  fetchBook?: (ticker: string) => Promise<{ yesAsk: number; yesAskSize: number; noAsk: number; noAskSize: number } | null>;
  readCash?: () => Promise<Array<{ index: number; dollars: number | null; label: string }>>;
  send?: (body: unknown) => Promise<{ status: number; body: unknown }>;
  log?: (entry: Record<string, unknown>) => void;
};

export type OrderResult =
  | { ok: true; order: Record<string, unknown>; logged: true }
  | { ok: false; status: number; error: string; code: string; fresh?: Record<string, unknown>; logged: boolean };

const TICKER = /^[A-Z0-9._-]{2,80}$/;

export async function placeConfirmedOrder(input: OrderRequest, deps: OrderDeps): Promise<OrderResult> {
  const log = deps.log ?? ((entry) => appendOrderLog(deskRoot(deps.env), entry));
  const reject = (status: number, code: string, error: string, logged = false, fresh?: Record<string, unknown>): OrderResult => {
    if (logged) {
      log({
        at: new Date().toISOString(),
        code,
        error,
        ticker: typeof input.ticker === "string" ? input.ticker : "",
        side: input.side,
        count: input.count,
        price: input.price,
        source: input.source,
      });
    }
    return { ok: false, status, error, code, fresh, logged };
  };

  if (input.source !== "user-confirm") {
    return reject(403, "not_user", "Orders are only placed from an explicit confirmation. Nothing was placed.");
  }
  if (input.confirm !== true) {
    return reject(400, "no_confirm", "Confirm this exact trade before anything is placed. Nothing was placed.");
  }
  if (!passwordConfigured(deps.env.MONEY_DESK_APPROVAL_PASSWORD)) {
    return reject(403, "password_unset", "MONEY_DESK_APPROVAL_PASSWORD is not set. Nothing was placed.");
  }
  if (!approvalPasswordOk(input.password, deps.env.MONEY_DESK_APPROVAL_PASSWORD)) {
    return reject(403, "password_rejected", "Approval rejected. Nothing was placed.", true);
  }

  const ticker = typeof input.ticker === "string" ? input.ticker.trim() : "";
  const side = input.side === "YES" || input.side === "NO" ? input.side : null;
  const count = typeof input.count === "number" ? input.count : Number(input.count);
  const price = typeof input.price === "number" ? input.price : Number(input.price);
  const acknowledged = typeof input.acknowledgedPrice === "number" ? input.acknowledgedPrice : Number(input.acknowledgedPrice);
  if (!TICKER.test(ticker) || !side || !Number.isFinite(count) || count <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return reject(400, "bad_order", "Ticker, side, count, and price must describe one exact trade. Nothing was placed.", true);
  }
  if (!Number.isFinite(acknowledged)) {
    return reject(400, "no_ack", "The previewed price has to be acknowledged. Nothing was placed.", true);
  }
  if (!keysConfigured(deps.env)) {
    return reject(403, "kalshi_unset", "KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM is not set. Nothing was placed.", true);
  }

  const market = await (deps.fetchMarket ?? fetchMarket)(ticker);
  if (!market) return reject(404, "no_market", `No Kalshi market for ${ticker}. Nothing was placed.`, true);
  const exchangeIndex = market.exchange_index;
  if (exchangeIndex == null || !Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
    return reject(400, "no_shard", "This market has no exchange_index. Refusing to guess a shard. Nothing was placed.", true);
  }
  const book = await (deps.fetchBook ?? fetchOrderbook)(ticker);
  const quoted = liveAsk(market, book, side);
  if (!(quoted.price > 0) || quoted.price >= 1) {
    return reject(409, "no_quote", "No live ask. Nothing was placed.", true);
  }
  let serverEdge = input.serverEdge;
  if (deps.edgeFor) {
    try {
      serverEdge = await deps.edgeFor(ticker, side, quoted.price, count);
    } catch {
      serverEdge = null;
    }
  }
  const modelEdge = Number(input.acknowledgedEdge);
  const priceMoved = Math.abs(quoted.price - acknowledged) >= MATERIAL_PRICE_MOVE - 1e-9;
  const edgeBroken = Number.isFinite(modelEdge) && modelEdge >= 2 && serverEdge != null && serverEdge < 2;
  if (priceMoved || quoted.price > price + 0.001) {
    return reject(409, "price_moved", "The price moved. Nothing was placed. Confirm the new price and edge.", true, {
      ask: quoted.price,
      depth: quoted.size,
      fee_dollars: takerFeeDollars(quoted.price, count),
      edge_cents: serverEdge,
      acknowledged_edge: Number.isFinite(modelEdge) ? modelEdge : null,
    });
  }
  if (edgeBroken) {
    return reject(409, "edge_moved", "The edge fell below 2 cents. Nothing was placed. Confirm the new price and edge.", true, {
      ask: quoted.price,
      depth: quoted.size,
    });
  }
  if (quoted.size + 1e-9 < count) {
    return reject(409, "thin_book", `Only ${quoted.size} contracts are on the ask. Nothing was placed.`, true);
  }

  let cash: Array<{ index: number; dollars: number | null; label: string }> = [];
  try {
    cash = await (deps.readCash ?? (() => readShardCash(deps.env)))();
  } catch (error) {
    return reject(502, "balance_unread", `Shard cash could not be read (${error instanceof Error ? error.message : "error"}). Nothing was placed.`, true);
  }
  const shard = cash.find((row) => row.index === exchangeIndex);
  const cost = count * price + takerFeeDollars(price, count);
  const available = shard?.dollars;
  if (available == null) {
    return reject(409, "cash_unknown", `Cash on shard ${exchangeIndex} (${shardLabel(exchangeIndex)}) was not in the balance response. Nothing was placed and no transfer was sent.`, true);
  }
  if (available + 1e-9 < cost) {
    return reject(409, "insufficient_balance", `Shard ${exchangeIndex} (${shard?.label || shardLabel(exchangeIndex)}) has $${available.toFixed(2)}. This order needs $${cost.toFixed(2)} on that shard. Cash was not moved. Nothing was placed.`, true);
  }

  let body;
  try {
    body = buildV2BuyOrder({
      ticker,
      side,
      count,
      price,
      exchangeIndex,
      clientOrderId: randomUUID(),
    });
  } catch (error) {
    return reject(400, "bad_order", error instanceof Error ? error.message : "Bad order. Nothing was placed.", true);
  }

  const send = deps.send ?? ((payload) => signedKalshi(deps.env, "POST", "/portfolio/events/orders", payload));
  let response: { status: number; body: unknown };
  try {
    response = await send(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "order request failed";
    log({ at: new Date().toISOString(), code: "transport", error: message, ticker, side, count, price, exchange_index: market.exchange_index, request: publicOrder(body) });
    return { ok: false, status: 502, code: "transport", error: `${message} Nothing else was tried.`, logged: true };
  }
  const failed = response.status >= 400;
  const message = kalshiMessage(response.body) || (failed ? `Kalshi HTTP ${response.status}` : "placed");
  log({
    at: new Date().toISOString(),
    code: failed ? "exchange_rejected" : "placed",
    error: failed ? message : undefined,
    ticker,
    side,
    count,
    price,
    exchange_index: market.exchange_index,
    request: publicOrder(body),
    response: response.body,
    http_status: response.status,
  });
  if (failed) {
    return { ok: false, status: response.status, code: "exchange_rejected", error: `${message} Nothing was retried and no other market was tried.`, logged: true };
  }
  return { ok: true, logged: true, order: { request: publicOrder(body), response: response.body, shard: market.exchange_index, cost } };
}

function liveAsk(market: RawMarket, book: { yesAsk: number; yesAskSize: number; noAsk: number; noAskSize: number } | null, side: "YES" | "NO"): { price: number; size: number } {
  const fromMarket = marketAsk(market, side);
  if (!book) return fromMarket;
  const fromBook = side === "YES" ? { price: book.yesAsk, size: book.yesAskSize } : { price: book.noAsk, size: book.noAskSize };
  if (!(fromBook.price > 0)) return fromMarket;
  return { price: fromBook.price, size: fromBook.size || fromMarket.size };
}

function publicOrder(body: ReturnType<typeof buildV2BuyOrder>): Record<string, unknown> {
  return { ...body };
}

function kalshiMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as { message?: unknown; error?: unknown; code?: unknown };
  return [record.code, record.message || record.error].filter(Boolean).join(": ");
}

export async function previewOrder(input: { ticker: string; side: "YES" | "NO"; count: number; price: number }, deps: OrderDeps): Promise<Record<string, unknown>> {
  const market = await (deps.fetchMarket ?? fetchMarket)(input.ticker);
  if (!market) return { ok: false, error: "Market not found. Nothing was placed." };
  const book = await (deps.fetchBook ?? fetchOrderbook)(input.ticker);
  const quoted = liveAsk(market, book, input.side);
  const fee = takerFeeDollars(quoted.price || input.price, input.count);
  let cash: Array<{ index: number; dollars: number | null; label: string }> | null = null;
  let cashError = "";
  if (keysConfigured(deps.env)) {
    try {
      cash = await (deps.readCash ?? (() => readShardCash(deps.env)))();
    } catch (error) {
      cashError = error instanceof Error ? error.message : "balance unread";
    }
  }
  const shard = market.exchange_index;
  const row = cash?.find((item) => item.index === shard);
  return {
    ok: true,
    placed: false,
    ticker: input.ticker,
    side: input.side,
    count: input.count,
    acknowledgedPrice: quoted.price || input.price,
    fee_dollars: fee,
    cost_dollars: input.count * (quoted.price || input.price) + fee,
    depth: quoted.size,
    exchange_index: shard,
    shard_label: row?.label || (shard == null ? "unknown" : shardLabel(shard)),
    shard_cash: row?.dollars ?? null,
    cash_error: cashError,
    needs_keys: !keysConfigured(deps.env),
    needs_password: !passwordConfigured(deps.env.MONEY_DESK_APPROVAL_PASSWORD),
    transfer: "This app does not move cash between shards.",
  };
}

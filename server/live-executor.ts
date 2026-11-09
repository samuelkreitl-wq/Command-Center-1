/**
 * The only module that signs and sends an order.
 * Paper code must not import this file.
 */

import { loadPrivateKeyPem, kalshiTradeBase, signKalshiRequest } from "../money-os-desk/src/lib/kalshi-sign";
import type { OrderIntent } from "../money-os-desk/src/lib/order-gate";

function joinApi(base: string, path: string): string {
  const root = base.replace(/\/$/, "");
  if (root.endsWith("/trade-api/v2")) return `${root}${path.replace(/^\/trade-api\/v2/, "")}`;
  return `${root}${path}`;
}

export async function placeLimitOrder(order: OrderIntent, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<{ orderId: string; status: number; body: unknown }> {
  const pem = loadPrivateKeyPem(env);
  const keyId = env.KALSHI_API_KEY_ID;
  if (!pem || !keyId) throw new Error("Kalshi credentials are not configured");
  const path = "/trade-api/v2/portfolio/orders";
  const timestamp = Date.now().toString();
  const signature = signKalshiRequest(pem, timestamp, "POST", path);
  const price = order.limitPrice.toFixed(4);
  const payload = {
    ticker: order.ticker,
    client_order_id: order.clientOrderId,
    action: order.action,
    side: order.side,
    count: order.count,
    type: "limit",
    ...(order.side === "yes" ? { yes_price_dollars: price } : { no_price_dollars: price }),
  };
  const response = await fetchImpl(joinApi(kalshiTradeBase(env), path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Kalshi order HTTP ${response.status}`) as Error & { status: number; body: unknown };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const orderId = String((body as { order?: { order_id?: string } }).order?.order_id || "");
  return { orderId, status: response.status, body };
}

export async function cancelLimitOrder(orderId: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<void> {
  const pem = loadPrivateKeyPem(env);
  const keyId = env.KALSHI_API_KEY_ID;
  if (!pem || !keyId) throw new Error("Kalshi credentials are not configured");
  const path = `/trade-api/v2/portfolio/orders/${orderId}`;
  const timestamp = Date.now().toString();
  const signature = signKalshiRequest(pem, timestamp, "DELETE", path);
  const response = await fetchImpl(joinApi(kalshiTradeBase(env), path), {
    method: "DELETE",
    headers: {
      accept: "application/json",
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature,
    },
  });
  if (!response.ok) throw new Error(`Kalshi cancel HTTP ${response.status}`);
}

export async function readExposure(ticker: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<{ blocked: boolean; side?: "yes" | "no"; count?: number; price?: number }> {
  const pem = loadPrivateKeyPem(env);
  const keyId = env.KALSHI_API_KEY_ID;
  if (!pem || !keyId) return { blocked: false };
  const positions = await signedGet("/trade-api/v2/portfolio/positions", env, fetchImpl, pem, keyId);
  const orders = await signedGet(`/trade-api/v2/portfolio/orders?status=resting&ticker=${encodeURIComponent(ticker)}`, env, fetchImpl, pem, keyId);
  const held = exposureFrom(positions, orders, ticker);
  return held ?? { blocked: false };
}

async function signedGet(pathAndQuery: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch, pem: string, keyId: string) {
  const path = pathAndQuery.split("?")[0];
  const timestamp = Date.now().toString();
  const signature = signKalshiRequest(pem, timestamp, "GET", path);
  const response = await fetchImpl(joinApi(kalshiTradeBase(env), pathAndQuery), {
    headers: {
      accept: "application/json",
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature,
    },
  });
  if (!response.ok) throw new Error(`Kalshi HTTP ${response.status}`);
  return response.json();
}

function exposureFrom(positions: unknown, orders: unknown, ticker: string): { blocked: true; side: "yes" | "no"; count: number; price: number } | null {
  const markets = (positions as { market_positions?: Record<string, unknown>[] })?.market_positions ?? [];
  for (const row of markets) {
    if (row.ticker !== ticker) continue;
    const qty = Number(row.position_fp ?? row.position ?? 0);
    if (!qty) continue;
    const count = Math.abs(qty);
    const exposure = Number(row.market_exposure_dollars ?? 0);
    return { blocked: true, side: qty > 0 ? "yes" : "no", count, price: count ? Math.abs(exposure) / count : 0 };
  }
  const resting = (orders as { orders?: Record<string, unknown>[] })?.orders ?? [];
  for (const row of resting) {
    if (row.ticker !== ticker) continue;
    const count = Number(row.remaining_count_fp ?? row.remaining_count ?? row.count ?? 0);
    if (!count) continue;
    const side = String(row.side || "yes").toLowerCase() === "no" ? "no" : "yes";
    const price = Number(side === "yes" ? row.yes_price_dollars : row.no_price_dollars ?? row.yes_price_dollars);
    return { blocked: true, side, count, price: Number.isFinite(price) ? price : 0 };
  }
  return null;
}

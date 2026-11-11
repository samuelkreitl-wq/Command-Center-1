import { kalshiAuthHeaders, kalshiBase, KALSHI_PREFIX, loadPrivateKeyPem } from "./kalshi-sign.js";

export type ShardCash = { index: number; dollars: number | null; label: string };

const FALLBACK_LABELS: Record<number, string> = {
  0: "general",
  1: "combos",
  2: "crypto and commodities",
  3: "sports",
};

export function keysConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.KALSHI_API_KEY_ID && loadPrivateKeyPem(env));
}

export async function signedKalshi(
  env: Record<string, string | undefined>,
  method: string,
  pathWithQuery: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const base = kalshiBase(env);
  const path = pathWithQuery.startsWith("/trade-api/") ? pathWithQuery : `${KALSHI_PREFIX}${pathWithQuery}`;
  const headers = kalshiAuthHeaders(env, method, path);
  const res = await fetch(`${base.replace(/\/trade-api\/v2$/, "")}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text.slice(0, 400) };
  }
  return { status: res.status, body: parsed };
}

export async function readShardCash(env: Record<string, string | undefined>): Promise<ShardCash[]> {
  const { status, body } = await signedKalshi(env, "GET", "/portfolio/balance");
  if (status >= 400) {
    const message = typeof body === "object" && body && "message" in body ? String((body as { message?: unknown }).message) : `HTTP ${status}`;
    throw new Error(message);
  }
  const payload = (body ?? {}) as {
    balance?: number;
    balance_dollars?: string;
    balance_breakdown?: Array<{ exchange_index?: number; balance?: number; balance_dollars?: string }>;
  };
  const rows = payload.balance_breakdown;
  if (Array.isArray(rows) && rows.length) {
    return rows.map((row) => ({
      index: Number(row.exchange_index ?? 0),
      dollars: dollarsOf(row.balance_dollars, row.balance),
      label: FALLBACK_LABELS[Number(row.exchange_index ?? 0)] || `shard ${row.exchange_index}`,
    }));
  }
  return [{ index: 0, dollars: dollarsOf(payload.balance_dollars, payload.balance), label: FALLBACK_LABELS[0] }];
}

function dollarsOf(dollars: string | undefined, cents: number | undefined): number | null {
  if (dollars != null && dollars !== "" && Number.isFinite(Number(dollars))) return Number(dollars);
  if (typeof cents === "number" && Number.isFinite(cents)) return cents / 100;
  return null;
}

export function shardLabel(index: number): string {
  return FALLBACK_LABELS[index] || `shard ${index}`;
}

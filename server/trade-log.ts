import { keysConfigured, signedKalshi } from "./kalshi-private.js";
import { fetchMarket, type RawMarket } from "./kalshi-public.js";
import { mapPool } from "./net.js";
import {
  assertFeedUrl,
  buildTradeLog,
  parseShards,
  resolveFeedUrl,
  shardIndexes,
  tickersFromPositions,
  yesMark,
  type TradeLogView,
} from "../money-os-desk/src/lib/trade-log.js";

type Quote = {
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
};

export type TradeLogDeps = {
  env?: Record<string, string | undefined>;
  now?: () => number;
  fetchFeed?: (url: string) => Promise<unknown>;
  get?: (path: string) => Promise<{ status: number; body: unknown }>;
  fetchMarket?: (ticker: string) => Promise<Quote | null>;
};

const PAGE_CAP = 25;

class KalshiStatusError extends Error {
  status: number;
  constructor(status: number) {
    super(`Kalshi HTTP ${status}`);
    this.name = "KalshiStatusError";
    this.status = status;
  }
}

/**
 * Read-only portfolio snapshot. Never places or cancels an order.
 * Fills and positions are read once per exchange shard when the balance
 * payload lists them. Settlements have no shard filter; one read returns
 * every shard, and each row carries exchange_index. Subaccount is omitted:
 * fills and settlements then include every subaccount, and positions stay
 * on the API default (the primary subaccount).
 */
export async function loadTradeLog(deps: TradeLogDeps = {}): Promise<TradeLogView> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? Date.now();
  const configured = keysConfigured(env);
  let feed: unknown = null;
  let feedError: string | null = null;
  let feedHost: string | null = null;
  try {
    const url = assertFeedUrl(resolveFeedUrl(env));
    feedHost = url.hostname;
    feed = await (deps.fetchFeed ?? defaultFetchFeed)(url.toString());
  } catch (error) {
    feedError = cleanError(error);
  }

  if (!configured) {
    return buildTradeLog({
      now,
      feed,
      feedError,
      feedHost,
      kalshi: {
        configured: false,
        error: null,
        shards: [],
        fills: [],
        settlements: [],
        positions: [],
        marks: {},
        fillsOk: false,
        settlementsOk: false,
        positionsOk: false,
      },
    });
  }

  const get = deps.get ?? ((path: string) => signedKalshi(env, "GET", path));
  const quoteFor = deps.fetchMarket ?? ((ticker: string) => fetchMarket(ticker) as Promise<(RawMarket & Quote) | null>);
  try {
    const portfolio = await readPortfolio(get);
    const marks: Record<string, number | null> = {};
    if (portfolio.positionsOk) {
      const tickers = tickersFromPositions(portfolio.positions);
      await mapPool(tickers, 4, async (ticker) => {
        try {
          marks[ticker] = yesMark(await quoteFor(ticker));
        } catch {
          marks[ticker] = null;
        }
      });
    }
    return buildTradeLog({
      now,
      feed,
      feedError,
      feedHost,
      kalshi: {
        configured: true,
        error: portfolio.error,
        shards: portfolio.shards,
        fills: portfolio.fills,
        settlements: portfolio.settlements,
        positions: portfolio.positions,
        marks,
        fillsOk: portfolio.fillsOk,
        settlementsOk: portfolio.settlementsOk,
        positionsOk: portfolio.positionsOk,
      },
    });
  } catch (error) {
    return buildTradeLog({
      now,
      feed,
      feedError,
      feedHost,
      kalshi: {
        configured: true,
        error: cleanError(error),
        shards: [],
        fills: [],
        settlements: [],
        positions: [],
        marks: {},
        fillsOk: false,
        settlementsOk: false,
        positionsOk: false,
      },
    });
  }
}

async function readPortfolio(get: NonNullable<TradeLogDeps["get"]>): Promise<{
  shards: ReturnType<typeof parseShards>;
  fills: unknown[];
  settlements: unknown[];
  positions: unknown[];
  fillsOk: boolean;
  settlementsOk: boolean;
  positionsOk: boolean;
  error: string | null;
}> {
  const errors: string[] = [];
  let shards: ReturnType<typeof parseShards> = [];
  let indexes: number[] | null = null;
  try {
    const balance = await get("/portfolio/balance");
    if (balance.status >= 400) throw new KalshiStatusError(balance.status);
    shards = parseShards(balance.body);
    indexes = shardIndexes(balance.body);
  } catch (error) {
    errors.push(`Balance: ${cleanError(error)}`);
  }

  const fills = await readScoped(get, "/portfolio/fills", "fills", {}, indexes, errors, "Fills");
  const positions = await readScoped(
    get,
    "/portfolio/positions",
    "market_positions",
    { count_filter: "position", settlement_status: "unsettled" },
    indexes,
    errors,
    "Positions",
  );
  let settlements: unknown[] = [];
  let settlementsOk = false;
  try {
    settlements = await paginate(get, "/portfolio/settlements", "settlements", {});
    settlementsOk = true;
  } catch (error) {
    errors.push(`Settlements: ${cleanError(error)}`);
  }

  return {
    shards,
    fills: fills.rows,
    settlements,
    positions: positions.rows,
    fillsOk: fills.ok,
    settlementsOk,
    positionsOk: positions.ok,
    error: errors.length ? [...new Set(errors)].join(" ") : null,
  };
}

async function readScoped(
  get: NonNullable<TradeLogDeps["get"]>,
  path: string,
  listKey: string,
  query: Record<string, string>,
  indexes: number[] | null,
  errors: string[],
  label: string,
): Promise<{ rows: unknown[]; ok: boolean }> {
  if (!indexes || !indexes.length) {
    try {
      return { rows: await paginate(get, path, listKey, query), ok: true };
    } catch (error) {
      errors.push(`${label}: ${cleanError(error)}`);
      return { rows: [], ok: false };
    }
  }
  const rows: unknown[] = [];
  let ok = false;
  for (const index of indexes) {
    try {
      rows.push(...await paginate(get, path, listKey, { ...query, exchange_index: String(index) }));
      ok = true;
    } catch (error) {
      errors.push(`${label} shard ${index}: ${cleanError(error)}`);
    }
  }
  if (ok) return { rows, ok: true };
  try {
    return { rows: await paginate(get, path, listKey, query), ok: true };
  } catch (error) {
    errors.push(`${label}: ${cleanError(error)}`);
    return { rows: [], ok: false };
  }
}

async function paginate(
  get: NonNullable<TradeLogDeps["get"]>,
  path: string,
  listKey: string,
  query: Record<string, string>,
  allowBare = true,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor = "";
  const seen = new Set<string>();
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const { status, body } = await get(withQuery(path, { ...query, limit: "200", cursor: cursor || undefined }));
    if (status === 400 && allowBare && page === 0 && (query.count_filter || query.settlement_status)) {
      const bare = { ...query };
      delete bare.count_filter;
      delete bare.settlement_status;
      return paginate(get, path, listKey, bare, false);
    }
    if (status >= 400) throw new KalshiStatusError(status);
    const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const list = readList(payload, listKey);
    rows.push(...list);
    const next = payload && typeof payload.cursor === "string" ? payload.cursor : "";
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return rows;
}

function readList(payload: Record<string, unknown> | null, listKey: string): unknown[] {
  if (!payload) return [];
  if (Array.isArray(payload[listKey])) return payload[listKey] as unknown[];
  if (listKey === "market_positions" && Array.isArray(payload.positions)) return payload.positions as unknown[];
  return [];
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

async function defaultFetchFeed(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "money-os-desk/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  return message.replace(/https?:\/\/\S+/g, "feed").slice(0, 180);
}

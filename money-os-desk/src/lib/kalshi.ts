/**
 * Kalshi public market data (no auth).
 * Series: KXBTC15M (15m BTC direction). 5m: null until listed.
 */

import type { ContractWindow, MarketWindow } from "./types";

export const KALSHI_BASE =
  "https://api.elections.kalshi.com/trade-api/v2";

export const SERIES_15M = "KXBTC15M";
export const SERIES_5M: string | null = null;

interface KalshiMarketRaw {
  ticker: string;
  event_ticker: string;
  status: string;
  floor_strike?: number;
  strike_type?: string;
  close_time: string;
  open_time?: string;
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  no_ask_dollars?: string;
  no_bid_dollars?: string;
  title?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  expiration_value?: string;
  last_price_dollars?: string;
}

/**
 * A listed KXBTC15M window, including ones whose strike is still TBD.
 * floorStrike is null when Kalshi has not published floor_strike.
 * That null is not a price. Callers must not fill it in.
 */
export interface Btc15ListedWindow {
  ticker: string;
  openTime: string;
  closeTime: string;
  floorStrike: number | null;
  strikeType: string | null;
  status: string;
  yesSubTitle: string;
  expirationValue: number | null;
}

export function publishedFloorStrike(
  value: number | null | undefined
): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function listedWindowFromMarket(
  m: KalshiMarketRaw
): Btc15ListedWindow | null {
  if (!m.ticker || !m.open_time || !m.close_time) return null;
  const expiration = m.expiration_value == null || m.expiration_value === ""
    ? null
    : Number(m.expiration_value);
  return {
    ticker: m.ticker,
    openTime: m.open_time,
    closeTime: m.close_time,
    floorStrike: publishedFloorStrike(m.floor_strike),
    strikeType: m.strike_type ?? null,
    status: m.status,
    yesSubTitle: m.yes_sub_title ?? "",
    expirationValue:
      expiration != null && Number.isFinite(expiration) && expiration > 0
        ? expiration
        : null,
  };
}

function dollars(s?: string): number {
  if (s == null || s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const FETCH_TIMEOUT_MS = 8_000;

async function getJson(path: string): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${KALSHI_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Kalshi HTTP ${res.status} ${url}`);
  }
  return res.json();
}

export function mapMarketToContract(
  m: KalshiMarketRaw,
  market: MarketWindow
): ContractWindow | null {
  const strike = Number(m.floor_strike);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    ticker: m.ticker,
    series: market === "15m" ? SERIES_15M : SERIES_5M || "UNKNOWN",
    market,
    strike,
    closeTime: m.close_time,
    yesAsk: dollars(m.yes_ask_dollars),
    noAsk: dollars(m.no_ask_dollars),
  };
}

export async function fetchOpenMarkets(
  seriesTicker: string
): Promise<KalshiMarketRaw[]> {
  const path = `/markets?series_ticker=${encodeURIComponent(
    seriesTicker
  )}&status=open&limit=20`;
  const data = (await getJson(path)) as { markets?: KalshiMarketRaw[] };
  const list = data.markets ?? [];
  return list.sort(
    (a, b) =>
      new Date(a.close_time).getTime() - new Date(b.close_time).getTime()
  );
}

export async function fetchActive15mContract(): Promise<ContractWindow | null> {
  const markets = await fetchOpenMarkets(SERIES_15M);
  for (const m of markets) {
    const c = mapMarketToContract(m, "15m");
    if (c) return c;
  }
  return null;
}

export async function fetchActive5mContract(): Promise<ContractWindow | null> {
  if (!SERIES_5M) return null;
  const markets = await fetchOpenMarkets(SERIES_5M);
  for (const m of markets) {
    const c = mapMarketToContract(m, "5m");
    if (c) return c;
  }
  return null;
}

export async function fetchActiveContract(
  market: MarketWindow
): Promise<ContractWindow | null> {
  return market === "5m"
    ? fetchActive5mContract()
    : fetchActive15mContract();
}

export type ListedWindowStatus = "open" | "unopened" | "settled";

/** Public list that keeps windows whose floor_strike is not published yet. */
export async function fetchListed15mWindows(
  status: ListedWindowStatus
): Promise<Btc15ListedWindow[]> {
  const path = `/markets?series_ticker=${encodeURIComponent(
    SERIES_15M
  )}&status=${encodeURIComponent(status)}&limit=100`;
  const data = (await getJson(path)) as { markets?: KalshiMarketRaw[] };
  const windows = (data.markets ?? [])
    .map((m) => listedWindowFromMarket(m))
    .filter((m): m is Btc15ListedWindow => m != null);
  return windows.sort(
    (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime()
  );
}

/** Orderbook bids-only; implied asks from reciprocal side. */
export async function fetchOrderbookAsks(ticker: string): Promise<{
  yesAsk: number;
  noAsk: number;
}> {
  const data = (await getJson(
    `/markets/${encodeURIComponent(ticker)}/orderbook`
  )) as {
    orderbook_fp?: {
      yes_dollars?: [string, string][];
      no_dollars?: [string, string][];
    };
  };
  const yesBids = data.orderbook_fp?.yes_dollars ?? [];
  const noBids = data.orderbook_fp?.no_dollars ?? [];
  const bestYesBid = yesBids.length
    ? Number(yesBids[yesBids.length - 1][0])
    : 0;
  const bestNoBid = noBids.length ? Number(noBids[noBids.length - 1][0]) : 0;
  const yesAsk =
    bestNoBid > 0 ? Math.round((1 - bestNoBid) * 10000) / 10000 : 0;
  const noAsk =
    bestYesBid > 0 ? Math.round((1 - bestYesBid) * 10000) / 10000 : 0;
  return { yesAsk, noAsk };
}

export async function enrichContractQuotes(
  contract: ContractWindow
): Promise<ContractWindow> {
  try {
    const book = await fetchOrderbookAsks(contract.ticker);
    return {
      ...contract,
      yesAsk: book.yesAsk || contract.yesAsk,
      noAsk: book.noAsk || contract.noAsk,
    };
  } catch {
    return contract;
  }
}

export async function fetchPublicTrades(
  ticker: string,
  limit = 20
): Promise<
  { ticker: string; price: number; count: number; side: string; ts: string }[]
> {
  const path = `/markets/trades?ticker=${encodeURIComponent(
    ticker
  )}&limit=${limit}`;
  const data = (await getJson(path)) as {
    trades?: {
      ticker: string;
      yes_price_dollars?: string;
      count_fp?: string;
      taker_side?: string;
      created_time?: string;
    }[];
  };
  return (data.trades ?? []).map((t) => ({
    ticker: t.ticker,
    price: dollars(t.yes_price_dollars),
    count: Number(t.count_fp) || 0,
    side: t.taker_side || "",
    ts: t.created_time || "",
  }));
}

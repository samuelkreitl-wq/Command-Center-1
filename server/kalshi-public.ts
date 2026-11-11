import { fetchJson } from "./net.js";

export type RawMarket = {
  ticker: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  close_time?: string;
  open_time?: string;
  floor_strike?: number | null;
  cap_strike?: number | null;
  strike_type?: string;
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  no_ask_dollars?: string;
  no_bid_dollars?: string;
  yes_ask_size_fp?: string;
  yes_bid_size_fp?: string;
  no_ask_size_fp?: string;
  exchange_index?: number;
  rules_primary?: string;
  rules_secondary?: string;
  volume_fp?: string;
};

export type SeriesMeta = {
  ticker: string;
  title: string;
  category: string;
  exchange_index?: number;
  fee_multiplier?: number;
  fee_type?: string;
  last_updated_ts?: string;
  frequency?: string;
};

export type Book = {
  yesAsk: number;
  yesAskSize: number;
  noAsk: number;
  noAskSize: number;
};

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchSeries(get: typeof fetchJson = fetchJson): Promise<SeriesMeta[]> {
  const data = (await get("https://api.elections.kalshi.com/trade-api/v2/series?limit=5000")) as {
    series?: SeriesMeta[];
  };
  return data.series ?? [];
}

export async function fetchOpenMarkets(series: string, get: typeof fetchJson = fetchJson, pages = 2): Promise<RawMarket[]> {
  const out: RawMarket[] = [];
  let cursor = "";
  for (let i = 0; i < pages; i++) {
    const url = new URL("https://api.elections.kalshi.com/trade-api/v2/markets");
    url.searchParams.set("series_ticker", series);
    url.searchParams.set("status", "open");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const data = (await get(url.toString())) as { markets?: RawMarket[]; cursor?: string };
    out.push(...(data.markets ?? []));
    cursor = data.cursor || "";
    if (!cursor) break;
  }
  return out;
}

export async function fetchMarket(ticker: string, get: typeof fetchJson = fetchJson): Promise<RawMarket | null> {
  const data = (await get(
    `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
  )) as { market?: RawMarket };
  return data.market ?? null;
}

export async function fetchOrderbook(ticker: string, get: typeof fetchJson = fetchJson): Promise<Book | null> {
  const data = (await get(
    `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`,
  )) as { orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] } };
  const yes = data.orderbook_fp?.yes_dollars ?? [];
  const no = data.orderbook_fp?.no_dollars ?? [];
  const bestYes = yes.length ? yes[yes.length - 1] : null;
  const bestNo = no.length ? no[no.length - 1] : null;
  const yesBid = bestYes ? num(bestYes[0]) : 0;
  const noBid = bestNo ? num(bestNo[0]) : 0;
  return {
    yesAsk: noBid > 0 ? Math.round((1 - noBid) * 10000) / 10000 : 0,
    yesAskSize: bestNo ? num(bestNo[1]) : 0,
    noAsk: yesBid > 0 ? Math.round((1 - yesBid) * 10000) / 10000 : 0,
    noAskSize: bestYes ? num(bestYes[1]) : 0,
  };
}

export function marketAsk(market: RawMarket, side: "YES" | "NO"): { price: number; size: number } {
  if (side === "YES") {
    return { price: num(market.yes_ask_dollars), size: num(market.yes_ask_size_fp) };
  }
  const size = num(market.no_ask_size_fp) || num(market.yes_bid_size_fp);
  return { price: num(market.no_ask_dollars), size };
}

export function marketSpread(market: RawMarket): number | null {
  const ask = num(market.yes_ask_dollars);
  const bid = num(market.yes_bid_dollars);
  if (!(ask > 0) || !(bid > 0) || ask >= 1) return null;
  return Math.round((ask - bid) * 10000) / 10000;
}

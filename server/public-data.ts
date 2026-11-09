/** Public GET helpers. This module never places an order. */

import { kalshiMarketBase } from "../money-os-desk/src/lib/kalshi-sign";
import type { ListedMarket } from "../money-os-desk/src/lib/window-resolve";

export function krakenBase(env: Record<string, string | undefined> = process.env): string {
  return (env.KRAKEN_API_BASE || "https://api.kraken.com/0/public").replace(/\/$/, "");
}

export async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

function dollars(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function mapMarket(raw: Record<string, unknown>): ListedMarket | null {
  if (typeof raw.ticker !== "string" || typeof raw.close_time !== "string") return null;
  const strike = Number(raw.floor_strike);
  return {
    ticker: raw.ticker,
    status: String(raw.status || ""),
    floorStrike: Number.isFinite(strike) && strike > 0 ? strike : null,
    closeTime: raw.close_time,
    openTime: typeof raw.open_time === "string" ? raw.open_time : undefined,
    yesAsk: dollars(raw.yes_ask_dollars),
    noAsk: dollars(raw.no_ask_dollars),
    yesBid: dollars(raw.yes_bid_dollars),
    noBid: dollars(raw.no_bid_dollars),
    title: typeof raw.title === "string" ? raw.title : undefined,
    result: typeof raw.result === "string" ? raw.result : undefined,
    expirationValue: typeof raw.expiration_value === "string" ? raw.expiration_value : undefined,
  };
}

export async function fetchMarkets(fetchImpl: typeof fetch, env: Record<string, string | undefined>, series: string, status: string): Promise<ListedMarket[]> {
  const url = `${kalshiMarketBase(env)}/markets?series_ticker=${encodeURIComponent(series)}&status=${encodeURIComponent(status)}&limit=200`;
  const data = await getJson(fetchImpl, url) as { markets?: Record<string, unknown>[] };
  return (data.markets ?? []).map(mapMarket).filter((market): market is ListedMarket => market != null);
}

export async function fetchKrakenLast(fetchImpl: typeof fetch, env: Record<string, string | undefined>): Promise<number | null> {
  const data = await getJson(fetchImpl, `${krakenBase(env)}/Ticker?pair=XBTUSD`) as { result?: Record<string, { c?: [string, string] }> };
  const row = data.result ? Object.values(data.result)[0] : undefined;
  const last = Number(row?.c?.[0]);
  return Number.isFinite(last) && last > 0 ? last : null;
}

export async function fetchCloses(fetchImpl: typeof fetch, env: Record<string, string | undefined>, interval: number): Promise<number[]> {
  const data = await getJson(fetchImpl, `${krakenBase(env)}/OHLC?pair=XBTUSD&interval=${interval}`) as { result?: Record<string, unknown> };
  const result = data.result ?? {};
  const key = Object.keys(result).find((item) => item !== "last");
  const rows = (key ? result[key] : []) as unknown[];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => Number((row as unknown[])[4])).filter((price) => price > 0);
}

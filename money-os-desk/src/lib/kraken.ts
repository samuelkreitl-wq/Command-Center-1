/**
 * Kraken public market data (REST).
 * Pair: XBTUSD / XXBTZUSD. No API key required.
 */

import type { SpotTick } from "./types";
import type { Bar1m } from "./engine";

const REST = "https://api.kraken.com/0/public";
const PAIR = "XBTUSD";

export interface KrakenTickerResult {
  last: number;
  bid: number;
  ask: number;
  ts: number;
}

const FETCH_TIMEOUT_MS = 8_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Kraken HTTP ${res.status} ${url}`);
  }
  return res.json();
}

/** Last trade price → SpotTick for the desk. */
export async function fetchKrakenSpot(): Promise<SpotTick> {
  const data = (await getJson(`${REST}/Ticker?pair=${PAIR}`)) as {
    error: string[];
    result: Record<
      string,
      { c: [string, string]; b: [string, string]; a: [string, string] }
    >;
  };
  if (data.error?.length) {
    throw new Error(`Kraken ticker error: ${data.error.join(", ")}`);
  }
  const key = Object.keys(data.result)[0];
  const row = data.result[key];
  const last = Number(row.c[0]);
  if (!Number.isFinite(last)) throw new Error("Kraken ticker: bad last");
  return {
    price: last,
    ts: Date.now(),
    source: "kraken",
  };
}

/**
 * Closed + forming 1m OHLC bars.
 * Kraken returns [time, open, high, low, close, vwap, volume, count]
 */
export async function fetchKrakenOhlc1m(
  sinceUnixSec?: number
): Promise<Bar1m[]> {
  const q = sinceUnixSec
    ? `${REST}/OHLC?pair=${PAIR}&interval=1&since=${sinceUnixSec}`
    : `${REST}/OHLC?pair=${PAIR}&interval=1`;
  const data = (await getJson(q)) as {
    error: string[];
    result: Record<string, (number | string)[][]> & { last?: number };
  };
  if (data.error?.length) {
    throw new Error(`Kraken OHLC error: ${data.error.join(", ")}`);
  }
  const key = Object.keys(data.result).find((k) => k !== "last");
  if (!key) return [];
  const rows = data.result[key] as (number | string)[][];
  return rows.map((r) => ({
    t: Number(r[0]) * 1000,
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[6]),
  }));
}

/** Full REST poll for desk: spot + recent 1m bars. */
export async function pollKraken(): Promise<{
  spot: SpotTick;
  bars: Bar1m[];
}> {
  const [spot, bars] = await Promise.all([
    fetchKrakenSpot(),
    fetchKrakenOhlc1m(),
  ]);
  return { spot, bars };
}

/** Browser WebSocket v2 helpers (optional). */
export const KRAKEN_WS_PUBLIC = "wss://ws.kraken.com/v2";

export function krakenTickerSubscribeMsg() {
  return {
    method: "subscribe",
    params: { channel: "ticker", symbol: ["BTC/USD"] },
  };
}

export function krakenOhlcSubscribeMsg() {
  return {
    method: "subscribe",
    params: { channel: "ohlc", symbol: ["BTC/USD"], interval: 1 },
  };
}

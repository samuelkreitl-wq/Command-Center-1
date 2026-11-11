import { lognormalAbove, stdev } from "../money-os-desk/src/lib/pricing.js";
import { fetchJson } from "./net.js";

export type Quote = { price: number; ts: string; source: string; receivedAt: string };

export type AssetSnap = {
  symbol: string;
  kraken: Quote | null;
  coinbase: Quote | null;
  sigma60: number | null;
  sigma240: number | null;
  proxy: string;
};

const ASSETS = [
  { symbol: "BTC", kraken: "XBTUSD", coinbase: "BTC-USD", index: "CF Benchmarks BRTI" },
  { symbol: "ETH", kraken: "ETHUSD", coinbase: "ETH-USD", index: "CF Benchmarks ERTI" },
  { symbol: "SOL", kraken: "SOLUSD", coinbase: "SOL-USD", index: "CF Benchmarks SOLUSD_RTI" },
] as const;

export const CRYPTO_SERIES: Record<string, { symbol: string; kind: "15m" | "hourly" }> = {
  KXBTC15M: { symbol: "BTC", kind: "15m" },
  KXETH15M: { symbol: "ETH", kind: "15m" },
  KXSOL15M: { symbol: "SOL", kind: "15m" },
  KXBTCD: { symbol: "BTC", kind: "hourly" },
  KXETHD: { symbol: "ETH", kind: "hourly" },
  KXSOLD: { symbol: "SOL", kind: "hourly" },
};

export async function loadAssetSnaps(now = new Date(), get: typeof fetchJson = fetchJson): Promise<Record<string, AssetSnap>> {
  const out: Record<string, AssetSnap> = {};
  await Promise.all(ASSETS.map(async (asset) => {
    const [kraken, coinbase, sigmas] = await Promise.all([
      krakenQuote(asset.kraken, now, get).catch(() => null),
      coinbaseQuote(asset.coinbase, now, get).catch(() => null),
      krakenSigmas(asset.kraken, get).catch(() => ({ sigma60: null, sigma240: null })),
    ]);
    out[asset.symbol] = {
      symbol: asset.symbol,
      kraken,
      coinbase,
      sigma60: sigmas.sigma60,
      sigma240: sigmas.sigma240,
      proxy: `${asset.index} proxy: Kraken ${asset.kraken} and Coinbase ${asset.coinbase} spot. Not the official 60-second average.`,
    };
  }));
  return out;
}

async function krakenQuote(pair: string, now: Date, get: typeof fetchJson): Promise<Quote | null> {
  const data = (await get(`https://api.kraken.com/0/public/Ticker?pair=${pair}`)) as {
    error?: string[];
    result?: Record<string, { c?: [string, string] }>;
  };
  if (data.error?.length) return null;
  const row = Object.values(data.result ?? {})[0];
  const price = Number(row?.c?.[0]);
  if (!(price > 0)) return null;
  const receivedAt = now.toISOString();
  return { price, ts: receivedAt, source: `Kraken ${pair} last`, receivedAt };
}

async function coinbaseQuote(product: string, now: Date, get: typeof fetchJson): Promise<Quote | null> {
  const data = (await get(`https://api.exchange.coinbase.com/products/${product}/ticker`)) as {
    price?: string;
    time?: string;
  };
  const price = Number(data.price);
  if (!(price > 0)) return null;
  const ts = data.time && !Number.isNaN(Date.parse(data.time)) ? data.time : now.toISOString();
  return { price, ts, source: `Coinbase ${product} spot`, receivedAt: now.toISOString() };
}

async function krakenSigmas(pair: string, get: typeof fetchJson): Promise<{ sigma60: number | null; sigma240: number | null }> {
  const data = (await get(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1`)) as {
    error?: string[];
    result?: Record<string, (number | string)[][]>;
  };
  if (data.error?.length) return { sigma60: null, sigma240: null };
  const key = Object.keys(data.result ?? {}).find((k) => k !== "last");
  const rows = key ? data.result?.[key] ?? [] : [];
  const closes = rows.map((row) => Number(row[4])).filter((n) => n > 0);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  return {
    sigma60: stdev(returns.slice(-60)),
    sigma240: stdev(returns.slice(-240)),
  };
}

export type CryptoFair = {
  fairYes: number;
  range: [number, number];
  variants: number[];
  spotsUsed: Quote[];
  stale: boolean;
  proxy: string;
  source: string;
};

export function cryptoFairYes(input: {
  snap: AssetSnap;
  strike: number;
  minutesLeft: number;
  kind: "15m" | "hourly";
  nowMs: number;
}): CryptoFair | null {
  const spots = [input.snap.kraken, input.snap.coinbase].filter((q): q is Quote => !!q && q.price > 0);
  const sigmas = [input.snap.sigma60, input.snap.sigma240].filter((s): s is number => s != null && s > 0);
  if (!spots.length || !sigmas.length || !(input.strike > 0)) return null;
  const minutes = Math.max(1, input.minutesLeft);
  const horizonScale = Math.sqrt(minutes);
  const variants: number[] = [];
  for (const spot of spots) {
    for (const sigma of sigmas) {
      variants.push(clamp01(lognormalAbove(spot.price, input.strike, sigma * horizonScale)));
    }
  }
  const freshMs = input.kind === "15m" ? 60_000 : 5 * 60_000;
  const stale = spots.some((spot) => input.nowMs - Date.parse(spot.ts) > freshMs);
  const fairYes = Math.min(...variants);
  return {
    fairYes,
    range: [Math.min(...variants), Math.max(...variants)],
    variants,
    spotsUsed: spots,
    stale,
    proxy: input.snap.proxy,
    source: `lognormal, zero drift, Kraken 1m realized vol (${sigmas.length} windows) × ${spots.map((s) => s.source).join(" + ")}. ${input.snap.proxy}`,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(0.999, Math.max(0.001, n));
}

export type DayForecast = { highF: number; source: string; issuedAt: string };

export async function loadCityForecast(city: string, day: string, get: typeof fetchJson = fetchJson): Promise<{
  forecasts: DayForecast[];
  weatherCompany: string;
  timestamps: Record<string, string>;
}> {
  const timestamps: Record<string, string> = {};
  const geo = (await get(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
  )) as { results?: Array<{ latitude: number; longitude: number; name: string }> };
  const hit = geo.results?.[0];
  if (!hit) return { forecasts: [], weatherCompany: "Weather Company forecast unreachable (city not geocoded)", timestamps };
  const forecasts: DayForecast[] = [];
  const [nws, meteo, company] = await Promise.allSettled([
    nwsHigh(hit.latitude, hit.longitude, day, get),
    meteoHigh(hit.latitude, hit.longitude, day, get),
    weatherCompanyHigh(hit.latitude, hit.longitude, get),
  ]);
  if (nws.status === "fulfilled" && nws.value) {
    forecasts.push(nws.value);
    timestamps.nws = nws.value.issuedAt;
  }
  if (meteo.status === "fulfilled" && meteo.value) {
    forecasts.push(meteo.value);
    timestamps.open_meteo = meteo.value.issuedAt;
  }
  let weatherCompany = "Weather Company forecast unreachable";
  if (company.status === "fulfilled" && company.value) {
    forecasts.push(company.value);
    timestamps.weather_company = company.value.issuedAt;
    weatherCompany = company.value.source;
  } else if (company.status === "rejected") {
    weatherCompany = "Weather Company forecast unreachable";
  }
  return { forecasts, weatherCompany, timestamps };
}

async function nwsHigh(lat: number, lon: number, day: string, get: typeof fetchJson): Promise<DayForecast | null> {
  const points = (await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`)) as {
    properties?: { forecast?: string; generatedAt?: string };
  };
  const forecastUrl = points.properties?.forecast;
  if (!forecastUrl || !forecastUrl.startsWith("https://api.weather.gov/")) return null;
  const forecast = (await get(forecastUrl)) as {
    properties?: { generatedAt?: string; periods?: Array<{ startTime: string; temperature: number; temperatureUnit?: string; isDaytime?: boolean }> };
  };
  const periods = forecast.properties?.periods ?? [];
  const highs = periods.filter((period) => period.isDaytime && period.startTime.slice(0, 10) === day && period.temperatureUnit !== "C");
  if (!highs.length) return null;
  const highF = Math.max(...highs.map((period) => period.temperature));
  return {
    highF,
    source: "NWS api.weather.gov daytime forecast",
    issuedAt: forecast.properties?.generatedAt || new Date().toISOString(),
  };
}

async function meteoHigh(lat: number, lon: number, day: string, get: typeof fetchJson): Promise<DayForecast | null> {
  const data = (await get(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=5`,
  )) as { daily?: { time?: string[]; temperature_2m_max?: number[] } };
  const times = data.daily?.time ?? [];
  const highs = data.daily?.temperature_2m_max ?? [];
  const index = times.indexOf(day);
  if (index < 0 || !(highs[index] > -80)) return null;
  return { highF: highs[index], source: "Open-Meteo daily maximum", issuedAt: new Date().toISOString() };
}

async function weatherCompanyHigh(lat: number, lon: number, get: typeof fetchJson): Promise<DayForecast | null> {
  const key = process.env.WEATHER_COMPANY_API_KEY;
  const url = key
    ? `https://api.weather.com/v3/wx/forecast/daily/5day?geocode=${lat},${lon}&format=json&units=e&language=en-US&apiKey=${encodeURIComponent(key)}`
    : `https://api.weather.com/v3/wx/forecast/daily/5day?geocode=${lat},${lon}&format=json&units=e&language=en-US`;
  const data = (await get(url)) as { calendarDayTemperatureMax?: number[]; validTimeUtc?: number[] };
  const high = data.calendarDayTemperatureMax?.[0];
  if (!(typeof high === "number")) return null;
  const issued = data.validTimeUtc?.[0] ? new Date(data.validTimeUtc[0] * 1000).toISOString() : new Date().toISOString();
  return { highF: high, source: "The Weather Company daily max", issuedAt: issued };
}

export function weatherFairYes(
  forecasts: DayForecast[],
  strikeType: string | undefined,
  floorStrike: number,
  capStrike?: number | null,
): { fairYes: number; range: [number, number]; variants: number[] } | null {
  if (!forecasts.length || !Number.isFinite(floorStrike)) return null;
  const kind = strikeType || "";
  if (kind !== "greater" && kind !== "greater_or_equal" && kind !== "less" && kind !== "less_or_equal" && kind !== "between") {
    return null;
  }
  if (kind === "between" && !(typeof capStrike === "number")) return null;
  const sigmas = [2, 3.5];
  const variants: number[] = [];
  for (const forecast of forecasts) {
    for (const sigma of sigmas) {
      variants.push(clamp01(weatherProb(kind, forecast.highF, sigma, floorStrike, capStrike)));
    }
  }
  return { fairYes: Math.min(...variants), range: [Math.min(...variants), Math.max(...variants)], variants };
}

function weatherProb(kind: string, mean: number, sigma: number, floorStrike: number, capStrike?: number | null): number {
  const cdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  if (kind === "between" && typeof capStrike === "number") {
    return cdf((capStrike + 0.5 - mean) / sigma) - cdf((floorStrike - 0.5 - mean) / sigma);
  }
  if (kind === "less" || kind === "less_or_equal") return cdf((floorStrike + 0.5 - mean) / sigma);
  const z = (floorStrike + 0.5 - mean) / sigma;
  return 1 - cdf(z);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

export function parseWeatherContract(rules: string, ticker: string): { city: string; day: string } | null {
  const cityMatch = rules.match(/recorded at\s+(.+?)\s*\(([A-Z0-9]+)\)/i);
  const dateMatch = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})-/i);
  if (!cityMatch || !dateMatch) return null;
  const months: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const month = months[dateMatch[2].toUpperCase()];
  if (!month) return null;
  const year = 2000 + Number(dateMatch[1]);
  return { city: cityMatch[1].trim(), day: `${year}-${month}-${dateMatch[3]}` };
}

export function quoteAgeMs(quote: Quote, nowMs: number): number {
  const ts = Date.parse(quote.ts);
  return Number.isFinite(ts) ? nowMs - ts : Number.POSITIVE_INFINITY;
}

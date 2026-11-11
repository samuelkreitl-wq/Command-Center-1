import { edgeCents, clearsEdgeThreshold, quarterKellyContracts, takerFeeDollars } from "../money-os-desk/src/lib/pricing.js";
import { formatEt } from "../money-os-desk/src/lib/window-name.js";
import {
  CRYPTO_SERIES,
  cryptoFairYes,
  loadAssetSnaps,
  loadCityForecast,
  parseWeatherContract,
  weatherFairYes,
  type AssetSnap,
} from "./fair.js";
import {
  fetchOpenMarkets,
  fetchOrderbook,
  fetchSeries,
  marketAsk,
  marketSpread,
  type RawMarket,
  type SeriesMeta,
} from "./kalshi-public.js";
import { fetchJson, mapPool } from "./net.js";
import { keysConfigured, readShardCash } from "./kalshi-private.js";
import { runRealityCheck } from "./reality.js";
import { fairFromBooks, loadOdds, matchEvent, type OddsEvent } from "./sports.js";
import {
  deskRoot,
  etDay,
  etHourStamp,
  isoEt,
  listSavedFiles,
  readSaved,
  archiveSaved,
  writeHourlyRecord,
  writeSaved,
  type DeskRecord,
} from "./store.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ScanReport = {
  startedAt: string;
  finishedAt: string;
  pass: DeskRecord[];
  watch: DeskRecord[];
  saved: DeskRecord[];
  coverage: Array<{ tab: string; status: string; model: string }>;
  errors: string[];
  failCount: number;
  timestamps: Record<string, string>;
};

type Get = typeof fetchJson;

type Candidate = {
  record: DeskRecord;
  score: number;
};

const SPORTS_SERIES = ["KXNBAGAME", "KXNFLGAME", "KXNHLGAME", "KXMLBGAME", "KXNCAAFGAME", "KXNCAAMBGAME"];

let inflight: Promise<ScanReport> | null = null;

export function runScan(options: { env?: Record<string, string | undefined>; now?: Date; get?: Get; root?: string } = {}): Promise<ScanReport> {
  if (inflight) return inflight;
  inflight = executeScan(options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function executeScan(options: { env?: Record<string, string | undefined>; now?: Date; get?: Get; root?: string }): Promise<ScanReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const get = options.get ?? fetchJson;
  const root = options.root ?? deskRoot(env);
  mkdirSync(root, { recursive: true });
  const errors: string[] = [];
  const timestamps: Record<string, string> = { scan: now.toISOString() };
  const bankrollByShard = await loadBankroll(env, errors);
  const assumed = Number(env.MONEY_DESK_ASSUMED_BANKROLL);
  const assumedBankroll = Number.isFinite(assumed) && assumed > 0 ? assumed : null;

  let series: SeriesMeta[] = [];
  try {
    series = await fetchSeries(get);
    timestamps.kalshi_series = new Date().toISOString();
  } catch (error) {
    errors.push(`series: ${error instanceof Error ? error.message : "unavailable"}`);
  }
  const byTicker = new Map(series.map((row) => [row.ticker, row]));
  const categories = new Map<string, SeriesMeta[]>();
  for (const row of series) {
    const name = row.category || "Other";
    const list = categories.get(name) ?? [];
    list.push(row);
    categories.set(name, list);
  }

  const snaps = await loadAssetSnaps(now, get).catch((error) => {
    errors.push(`crypto spots: ${error instanceof Error ? error.message : "unavailable"}`);
    return {} as Record<string, AssetSnap>;
  });
  timestamps.kraken = new Date().toISOString();
  timestamps.coinbase = new Date().toISOString();

  const oddsKey = env.ODDS_API_KEY;
  const odds = await loadOdds(oddsKey, get);
  if (odds.error) errors.push(`odds: ${odds.error}`);
  timestamps.odds = odds.missingKey ? "" : new Date().toISOString();

  const modeled: Candidate[] = [];
  const weatherCache = new Map<string, Awaited<ReturnType<typeof loadCityForecast>>>();

  const cryptoMarkets = await loadSeriesMarkets(Object.keys(CRYPTO_SERIES), get, errors);
  for (const market of cryptoMarkets) {
    const spec = CRYPTO_SERIES[seriesOf(market.ticker)];
    if (!spec) continue;
    const priced = priceCrypto(market, spec, snaps[spec.symbol], byTicker, now, bankrollByShard, assumedBankroll);
    if (priced) modeled.push(priced);
  }

  const weatherSeries = [...(categories.get("Climate and Weather") ?? [])]
    .filter((row) => /^KXHIGH/i.test(row.ticker))
    .sort((a, b) => String(b.last_updated_ts).localeCompare(String(a.last_updated_ts)))
    .slice(0, 12);
  const weatherMarkets = await loadSeriesMarkets(weatherSeries.map((row) => row.ticker), get, errors);
  for (const market of weatherMarkets) {
    const parsed = parseWeatherContract(`${market.rules_primary || ""} ${market.rules_secondary || ""}`, market.ticker);
    if (!parsed || market.floor_strike == null) continue;
    const key = `${parsed.city}|${parsed.day}`;
    if (!weatherCache.has(key)) {
      weatherCache.set(key, await loadCityForecast(parsed.city, parsed.day, get).catch((error) => {
        errors.push(`weather ${parsed.city}: ${error instanceof Error ? error.message : "unavailable"}`);
        return { forecasts: [], weatherCompany: "Weather Company forecast unreachable", timestamps: {} };
      }));
    }
    const city = weatherCache.get(key)!;
    Object.assign(timestamps, city.timestamps);
    const priced = priceWeather(market, parsed, city, byTicker, now, bankrollByShard, assumedBankroll);
    if (priced) modeled.push(priced);
  }

  if (!odds.missingKey) {
    const sportsMarkets = await loadSeriesMarkets(SPORTS_SERIES, get, errors);
    for (const market of sportsMarkets) {
      const priced = priceSports(market, odds.events, byTicker, now, bankrollByShard, assumedBankroll);
      if (priced) modeled.push(priced);
    }
  }

  await secondLook(modeled, get, errors);

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of modeled) {
    const tab = candidate.record.tab;
    const list = grouped.get(tab) ?? [];
    list.push(candidate);
    grouped.set(tab, list);
  }

  const pass: DeskRecord[] = [];
  const watch: DeskRecord[] = [];
  const coverage: ScanReport["coverage"] = [];
  let failCount = 0;
  const seenTabs = new Set<string>();

  for (const [tab, list] of grouped) {
    seenTabs.add(tab);
    list.sort((a, b) => b.score - a.score);
    const chosen = pickShown(list);
    const fails = list.filter((item) => item.record.verdict === "FAIL").slice(0, 5);
    failCount += list.filter((item) => item.record.verdict === "FAIL").length;
    for (const item of [...fails, ...(chosen.primary ? [chosen.primary] : []), ...chosen.extra]) {
      writeHourlyRecord(root, item.record, now);
    }
    if (chosen.primary) {
      if (chosen.primary.record.verdict === "PASS") pass.push(chosen.primary.record);
      else watch.push(chosen.primary.record);
      for (const extra of chosen.extra) {
        if (extra.record.verdict === "PASS") pass.push(extra.record);
      }
      coverage.push({ tab, status: chosen.primary.record.verdict, model: chosen.primary.record.model });
    } else {
      coverage.push({ tab, status: "no pick this hour (all candidates failed reality check)", model: list[0]?.record.model || "no model" });
    }
  }

  for (const [tab, rows] of categories) {
    if (seenTabs.has(tab)) continue;
    const sample = await sampleCategory(rows, get);
    const record = noModelRecord(tab, sample, now, odds.missingKey && tab === "Sports");
    writeHourlyRecord(root, record, now);
    watch.push(record);
    coverage.push({
      tab,
      status: record.watch_trigger || "WATCH",
      model: "no model",
    });
  }
  if (!categories.size) {
    for (const tab of ["Crypto", "Climate and Weather", "Commodities", "Financials", "Sports"]) {
      const record = noModelRecord(tab, null, now, tab === "Sports" && odds.missingKey);
      watch.push(record);
      coverage.push({ tab, status: "series list unavailable", model: "no model" });
    }
  }

  const saved = await refreshSaved(root, now, get, snaps, odds.events, byTicker, bankrollByShard, assumedBankroll, errors);
  for (const record of pass) {
    if (saved.some((row) => row.market.ticker === record.market.ticker && row.side === record.side)) continue;
    writeSaved(root, record, etHourStamp(now));
    saved.push(record);
  }
  const report: ScanReport = {
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    pass,
    watch,
    saved,
    coverage: coverage.sort((a, b) => a.tab.localeCompare(b.tab)),
    errors,
    failCount,
    timestamps,
  };
  writeFileSync(path.join(root, "latest.json"), JSON.stringify(report, null, 2));
  return report;
}

function pickShown(list: Candidate[]): { primary: Candidate | null; extra: Candidate[] } {
  const ranked = [...list].sort((a, b) => b.score - a.score);
  let primary: Candidate | null = null;
  for (const item of ranked) {
    if (item.record.verdict === "FAIL") continue;
    primary = item;
    break;
  }
  const extra = ranked.filter((item) => item !== primary && item.record.verdict === "PASS").slice(0, 2);
  return { primary, extra };
}

async function loadSeriesMarkets(series: string[], get: Get, errors: string[]): Promise<RawMarket[]> {
  const batches = await mapPool(series, 4, async (ticker) => {
    try {
      return await fetchOpenMarkets(ticker, get, 2);
    } catch (error) {
      errors.push(`${ticker}: ${error instanceof Error ? error.message : "unavailable"}`);
      return [];
    }
  });
  return batches.flat();
}

async function sampleCategory(rows: SeriesMeta[], get: Get): Promise<RawMarket | null> {
  const ordered = [...rows].sort((a, b) => String(b.last_updated_ts).localeCompare(String(a.last_updated_ts))).slice(0, 4);
  for (const row of ordered) {
    try {
      const markets = await fetchOpenMarkets(row.ticker, get, 1);
      const open = markets.find((market) => market.close_time && Date.parse(market.close_time) > Date.now());
      if (open) return open;
    } catch {
      /* try the next series in the tab */
    }
  }
  return null;
}

function priceCrypto(
  market: RawMarket,
  spec: { symbol: string; kind: "15m" | "hourly" },
  snap: AssetSnap | undefined,
  series: Map<string, SeriesMeta>,
  now: Date,
  bankrollByShard: Map<number, number>,
  assumed: number | null,
): Candidate | null {
  if (!snap || market.floor_strike == null || !(market.floor_strike > 0)) return null;
  const minutes = market.close_time ? (Date.parse(market.close_time) - now.getTime()) / 60000 : 0;
  if (!(minutes > 0) || minutes > 60 * 36) return null;
  const fair = cryptoFairYes({ snap, strike: market.floor_strike, minutesLeft: minutes, kind: spec.kind, nowMs: now.getTime() });
  if (!fair) return null;
  const near = Math.abs(Math.log((snap.kraken?.price || snap.coinbase?.price || market.floor_strike) / market.floor_strike));
  const yes = Number(market.yes_ask_dollars);
  if (near > 0.2 && (yes < 0.05 || yes > 0.95)) return null;
  return finishCandidate({
    market,
    series,
    now,
    fairYes: fair.fairYes,
    range: fair.range,
    variants: fair.variants,
    stale: fair.stale,
    model: "crypto lognormal",
    source: fair.source,
    proxy: fair.proxy,
    tab: "Crypto",
    rulesMatch: /CF Benchmarks|BRTI|RTI/i.test(market.rules_primary || ""),
    loss: `${spec.symbol} settles on the official average, not this spot proxy, and can gap through ${market.floor_strike}.`,
    bankrollByShard,
    assumed,
    timestamps: Object.fromEntries(fair.spotsUsed.map((spot) => [spot.source, spot.ts])),
    bookSeenTwice: false,
  });
}

function priceWeather(
  market: RawMarket,
  parsed: { city: string; day: string },
  city: Awaited<ReturnType<typeof loadCityForecast>>,
  series: Map<string, SeriesMeta>,
  now: Date,
  bankrollByShard: Map<number, number>,
  assumed: number | null,
): Candidate | null {
  if (market.floor_strike == null) return null;
  const fair = weatherFairYes(city.forecasts, market.strike_type, market.floor_strike, market.cap_strike);
  if (!fair) return null;
  const sources = new Set(city.forecasts.map((item) => item.source.split(" ")[0]));
  const issued = city.forecasts.map((item) => Date.parse(item.issuedAt)).filter((n) => Number.isFinite(n));
  const stale = issued.some((ts) => now.getTime() - ts > 6 * 60 * 60 * 1000);
  return finishCandidate({
    market,
    series,
    now,
    fairYes: fair.fairYes,
    range: fair.range,
    variants: fair.variants,
    stale,
    model: "weather blend",
    source: `Normal blend of ${city.forecasts.map((item) => item.source).join("; ")}. Settlement is ${/Weather Company/i.test(market.rules_primary || "") ? "The Weather Company" : "the rules text"}, not the NWS point forecast. ${city.weatherCompany}.`,
    proxy: `Forecast proxy for ${parsed.city} on ${parsed.day}. Not the settlement station's official high.`,
    tab: "Climate and Weather",
    rulesMatch: /temperature/i.test(market.rules_primary || ""),
    loss: `A sea breeze, a late front, or the settlement station (${parsed.city}) can miss the blended forecast.`,
    bankrollByShard,
    assumed,
    timestamps: Object.fromEntries(city.forecasts.map((item) => [item.source, item.issuedAt])),
    bookSeenTwice: false,
    singleSource: sources.size < 2,
    cannotPass: /Weather Company/i.test(market.rules_primary || "") && !city.forecasts.some((item) => /Weather Company/i.test(item.source)),
  });
}

function priceSports(
  market: RawMarket,
  events: OddsEvent[],
  series: Map<string, SeriesMeta>,
  now: Date,
  bankrollByShard: Map<number, number>,
  assumed: number | null,
): Candidate | null {
  const text = `${market.yes_sub_title || ""} ${market.title || ""} ${market.rules_primary || ""}`;
  const matched = matchEvent(text, events);
  if (!matched) return null;
  const quote = fairFromBooks(matched.event, matched.team, now.getTime());
  if (!quote || quote.threeWay) return null;
  return finishCandidate({
    market,
    series,
    now,
    fairYes: Math.min(quote.fairPower, quote.fairMult),
    range: [Math.min(quote.fairPower, quote.fairMult), Math.max(quote.fairPower, quote.fairMult)],
    variants: [quote.fairPower, quote.fairMult],
    stale: quote.stale,
    model: "sports no-vig",
    source: `${quote.book} no-vig (lower of power and multiplicative). Sharp book preferred.`,
    proxy: "Sportsbook no-vig line, not a Kalshi settlement.",
    tab: "Sports",
    rulesMatch: /wins/i.test(market.rules_primary || ""),
    loss: "A lineup change, overtime rule, or postponed game can void one leg and not the other.",
    bankrollByShard,
    assumed,
    timestamps: { [quote.book]: quote.updated || now.toISOString() },
    bookSeenTwice: false,
  });
}

function finishCandidate(input: {
  market: RawMarket;
  series: Map<string, SeriesMeta>;
  now: Date;
  fairYes: number;
  range: [number, number];
  variants: number[];
  stale: boolean;
  model: string;
  source: string;
  proxy: string;
  tab: string;
  rulesMatch: boolean;
  loss: string;
  bankrollByShard: Map<number, number>;
  assumed: number | null;
  timestamps: Record<string, string>;
  bookSeenTwice: boolean;
  singleSource?: boolean;
  cannotPass?: boolean;
}): Candidate | null {
  const meta = input.series.get(seriesOf(input.market.ticker));
  const multiplier = meta?.fee_multiplier && meta.fee_multiplier > 0 ? meta.fee_multiplier : 1;
  const yes = marketAsk(input.market, "YES");
  const no = marketAsk(input.market, "NO");
  const sides = [
    sideQuote("YES", yes.price, yes.size, input.fairYes, input.variants, multiplier),
    sideQuote("NO", no.price, no.size, 1 - Math.max(...input.variants), input.variants.map((v) => 1 - v), multiplier),
  ].filter((side): side is NonNullable<typeof side> => side != null);
  if (!sides.length) return null;
  sides.sort((a, b) => b.cents - a.cents);
  const best = sides[0];
  const shard = input.market.exchange_index ?? meta?.exchange_index ?? null;
  const bankroll = shard != null && input.bankrollByShard.has(shard) ? input.bankrollByShard.get(shard)! : input.assumed;
  const contracts = bankroll != null ? quarterKellyContracts(best.fair, best.price, bankroll, Math.max(best.depth, 0)) : 0;
  const sized = contracts > 0 ? contracts : 1;
  const cents = edgeCents(best.fair, best.price, sized, multiplier);
  const fee = takerFeeDollars(best.price, sized, multiplier);
  const worstClears = input.singleSource ? false : clearsEdgeThreshold(cents, best.price) && best.allClear;
  const spread = marketSpread(input.market);
  const minutes = input.market.close_time ? (Date.parse(input.market.close_time) - input.now.getTime()) / 60000 : null;
  const cashKnown = shard != null && input.bankrollByShard.has(shard);
  const reality = runRealityCheck({
    rulesRead: Boolean(input.market.rules_primary),
    rulesMatchModel: input.rulesMatch,
    stale: input.stale,
    timestampsPresent: Object.keys(input.timestamps).length > 0,
    depth: best.depth,
    plannedContracts: Math.max(1, contracts),
    spread,
    bookSeenTwice: input.bookSeenTwice,
    overlapsOpen: false,
    variants: input.singleSource ? 1 : input.variants.length,
    worstEdgeCents: cents,
    onlyOneVariantPositive: !best.allClear && best.anyClear,
    feesIncluded: true,
    edgeSurvivesFees: cents >= 2,
    lossScenario: input.loss,
    closesWithinMinutes: minutes,
    cashKnown,
    cashDisclosedIfUnknown: true,
    noModel: false,
    thresholdClears: worstClears && !input.stale,
  });
  let verdict = reality.verdict;
  if ((input.stale || input.cannotPass) && verdict === "PASS") verdict = "WATCH";
  const shown = verdict !== "FAIL";
  const closeEt = input.market.close_time ? formatEt(input.market.close_time) : "";
  const record: DeskRecord = {
    schema_version: "1.0",
    id: `${input.market.ticker}-${best.side}`.replace(/[^A-Za-z0-9._-]+/g, "-"),
    source: "money-bot",
    source_bot: "money-os-desk",
    created_at: isoEt(input.now),
    market: {
      title: input.market.title || input.market.ticker,
      ticker: input.market.ticker,
      event_ticker: input.market.event_ticker,
      category: input.tab === "Crypto" ? "crypto" : input.tab === "Sports" ? "sports" : input.tab === "Climate and Weather" ? "weather" : "other",
      close_time_et: input.market.close_time,
      settlement_source: (input.market.rules_primary || "").slice(0, 240),
      kalshi_shard: shard ?? undefined,
    },
    venues: [{
      venue: "kalshi",
      side: best.side,
      price: best.price,
      price_format: "kalshi_dollars",
      depth_at_price: best.depth,
      quote_time: input.now.toISOString(),
    }],
    side: best.side,
    price: best.price,
    fair_prob: best.fair,
    fair_prob_source: input.source,
    fair_prob_range: input.range,
    edge: { cents_per_contract_after_fees: round2(cents), fee_dollars: fee },
    stake_suggestion: {
      contracts,
      cost_dollars: round2(contracts * best.price + (contracts ? takerFeeDollars(best.price, contracts, multiplier) : 0)),
      max_loss_dollars: round2(contracts * best.price + (contracts ? takerFeeDollars(best.price, contracts, multiplier) : 0)),
      max_profit_dollars: round2(contracts * (1 - best.price)),
      method: bankroll == null
        ? "quarter Kelly fraction only; shard cash unread and MONEY_DESK_ASSUMED_BANKROLL unset"
        : cashKnown
          ? "quarter Kelly of cash on this shard"
          : "quarter Kelly of MONEY_DESK_ASSUMED_BANKROLL (not the live shard balance)",
      cash_needed_on_shard: shard == null ? {} : { [String(shard)]: round2(contracts * best.price) },
      transfer_needed: cashKnown ? undefined : "Shard cash was not read. No transfer is sent.",
    },
    confidence: input.variants.length >= 4 && !input.stale ? "medium" : "low",
    verdict,
    watch_trigger: verdict === "WATCH"
      ? (input.cannotPass
        ? "Weather Company forecast unreachable. NWS and Open-Meteo are proxies, so this stays WATCH."
        : reality.watch_trigger || "Re-check on a fresh scan")
      : undefined,
    reasons: [
      ...reality.reasons,
      `Rules: ${(input.market.rules_primary || "rules not on the payload").slice(0, 280)}`,
      input.bookSeenTwice ? "Book seen twice." : "Book seen once on the market payload.",
      `Window close ${closeEt}. 15-minute names are the end time.`,
    ],
    unverified: [
      input.proxy,
      input.stale ? "STALE" : "",
      cashKnown ? "" : "Shard cash was not verified this scan.",
      meta?.fee_type && meta.fee_type !== "quadratic" ? `Fee type ${meta.fee_type}; the quadratic taker formula was still used.` : "",
      "No news feed is priced.",
    ].filter(Boolean),
    data_timestamps: { kalshi: input.now.toISOString(), ...input.timestamps },
    expires_at: input.market.close_time || new Date(input.now.getTime() + 15 * 60_000).toISOString(),
    summary: [
      `${best.side} ${input.market.title || input.market.ticker} at ${best.price.toFixed(2)} (${contracts} contracts, needs your yes).`,
      `${input.source} Fair ${(best.fair * 100).toFixed(1)}%. Edge ${round2(cents)}c after fees.`,
      `${input.loss} ${verdict}.`,
    ],
    approval: "awaiting_samuel",
    shown_to_samuel: shown,
    tab: input.tab,
    model: input.model,
    proxy_label: input.proxy,
    depth: best.depth,
    spread,
    reality: { verdict: reality.verdict, failed: reality.failed },
  };
  return { record, score: cents };
}

function sideQuote(
  side: "YES" | "NO",
  price: number,
  depth: number,
  fair: number,
  variants: number[],
  multiplier: number,
): { side: "YES" | "NO"; price: number; depth: number; fair: number; cents: number; allClear: boolean; anyClear: boolean } | null {
  if (!(price > 0.01) || price >= 0.99) return null;
  const cents = edgeCents(fair, price, 1, multiplier);
  const clears = variants.map((variant) => clearsEdgeThreshold(edgeCents(variant, price, 1, multiplier), price));
  return { side, price, depth, fair, cents, allClear: clears.every(Boolean), anyClear: clears.some(Boolean) };
}

function noModelRecord(tab: string, market: RawMarket | null, now: Date, sportsNeedsKey: boolean): DeskRecord {
  const price = market ? Number(market.yes_ask_dollars) || 0 : 0;
  const trigger = sportsNeedsKey
    ? "Set ODDS_API_KEY for sportsbook no-vig lines"
    : "No fair-value model for this tab";
  return {
    schema_version: "1.0",
    id: `nomodel-${tab}-${market?.ticker || "none"}`.replace(/[^A-Za-z0-9._-]+/g, "-"),
    source: "money-bot",
    source_bot: "money-os-desk",
    created_at: isoEt(now),
    market: {
      title: market?.title || `${tab} has no priced market in this scan`,
      ticker: market?.ticker,
      event_ticker: market?.event_ticker,
      category: "other",
      close_time_et: market?.close_time,
      kalshi_shard: market?.exchange_index,
    },
    venues: [{ venue: "kalshi", side: "YES", price, price_format: "kalshi_dollars", quote_time: now.toISOString() }],
    side: "none",
    price,
    fair_prob: null,
    fair_prob_source: "no model",
    edge: { cents_per_contract_after_fees: 0, fee_dollars: 0 },
    stake_suggestion: {
      contracts: 0,
      cost_dollars: 0,
      max_loss_dollars: 0,
      method: "no model; no stake",
      transfer_needed: "No transfer is sent.",
    },
    confidence: "low",
    verdict: "WATCH",
    watch_trigger: `${trigger}. Best available, no real edge.`,
    reasons: [
      "Rules were not used to price this tab.",
      sportsNeedsKey ? "Sportsbook lines need ODDS_API_KEY." : "This tab is marked no model.",
      "Best available, no real edge.",
    ],
    unverified: ["no model"],
    data_timestamps: { kalshi: now.toISOString() },
    expires_at: market?.close_time || new Date(now.getTime() + 60 * 60_000).toISOString(),
    summary: [
      `${tab}: no model, so this is not a suggested bet.`,
      market ? `Sample market ${market.ticker} at ${price || "—"}.` : "No open sample market was returned.",
      `${trigger}. WATCH.`,
    ],
    approval: "none",
    shown_to_samuel: true,
    tab,
    model: "no model",
    proxy_label: "no model",
  };
}

async function secondLook(candidates: Candidate[], get: Get, errors: string[]): Promise<void> {
  const ranked = [...candidates].sort((a, b) => b.score - a.score).slice(0, 24);
  await mapPool(ranked, 4, async (candidate) => {
    const ticker = candidate.record.market.ticker;
    if (!ticker) return;
    try {
      const book = await fetchOrderbook(ticker, get);
      if (!book) return;
      const side = candidate.record.side === "NO" ? "NO" : "YES";
      const depth = side === "YES" ? book.yesAskSize : book.noAskSize;
      const ask = side === "YES" ? book.yesAsk : book.noAsk;
      candidate.record.depth = depth;
      candidate.record.reasons = candidate.record.reasons.map((reason) =>
        reason.startsWith("Book seen once") ? "Book seen twice." : reason,
      );
      const failed = new Set(candidate.record.reality?.failed ?? []);
      const edgeOk = candidate.record.edge.cents_per_contract_after_fees >= 2;
      const notStale = !(candidate.record.unverified || []).includes("STALE");
      const spreadOk = candidate.record.spread != null && candidate.record.spread <= 0.03;
      const proxyOnly = (candidate.record.proxy_label || "").includes("Not the settlement");
      if (!proxyOnly && depth >= 1 && edgeOk && notStale && spreadOk && [...failed].every((item) => item === "liquidity")) {
        candidate.record.verdict = "PASS";
        candidate.record.shown_to_samuel = true;
        candidate.record.watch_trigger = undefined;
      }
      if (ask > 0 && Math.abs(ask - candidate.record.price) >= 0.01) {
        candidate.record.verdict = candidate.record.verdict === "PASS" ? "WATCH" : candidate.record.verdict;
        candidate.record.watch_trigger = "Ask moved between the market payload and the book";
        candidate.record.unverified = [...(candidate.record.unverified || []), "Second book look disagreed by at least 1 cent."];
      }
      if ((candidate.record.stake_suggestion.contracts || 0) > depth) {
        candidate.record.verdict = "WATCH";
        candidate.record.watch_trigger = "Not enough depth at the ask for the suggested size";
      }
    } catch (error) {
      errors.push(`book ${ticker}: ${error instanceof Error ? error.message : "unavailable"}`);
    }
  });
}

async function refreshSaved(
  root: string,
  now: Date,
  get: Get,
  snaps: Record<string, AssetSnap>,
  events: OddsEvent[],
  series: Map<string, SeriesMeta>,
  bankrollByShard: Map<number, number>,
  assumed: number | null,
  errors: string[],
): Promise<DeskRecord[]> {
  const kept: DeskRecord[] = [];
  const stamp = etHourStamp(now);
  for (const filename of listSavedFiles(root)) {
    const prior = readSaved(root, filename);
    const ticker = prior?.market.ticker;
    if (!prior || !ticker) continue;
    try {
      const markets = await fetchOpenMarkets(seriesOf(ticker), get, 2);
      const market = markets.find((row) => row.ticker === ticker);
      if (!market || (market.close_time && Date.parse(market.close_time) <= now.getTime())) {
        prior.archive_note = "Closed or no longer open.";
        archiveSaved(root, filename, prior, etDay(now));
        continue;
      }
      const spec = CRYPTO_SERIES[seriesOf(ticker)];
      const repriced = spec
        ? priceCrypto(market, spec, snaps[spec.symbol], series, now, bankrollByShard, assumed)
        : parseWeatherContract(market.rules_primary || "", ticker)
          ? null
          : matchEvent(`${market.title} ${market.rules_primary}`, events)
            ? priceSports(market, events, series, now, bankrollByShard, assumed)
            : null;
      const weatherParsed = parseWeatherContract(`${market.rules_primary || ""}`, ticker);
      const weather = !spec && weatherParsed
        ? priceWeather(
          market,
          weatherParsed,
          await loadCityForecast(weatherParsed.city, weatherParsed.day, get),
          series,
          now,
          bankrollByShard,
          assumed,
        )
        : repriced;
      const next = weather;
      if (next && next.record.verdict === "PASS") {
        writeSaved(root, next.record, stamp);
        prior.archive_note = "Replaced by a newer still-good copy.";
        if (!filename.includes(stamp)) archiveSaved(root, filename, prior, etDay(now));
        kept.push(next.record);
      } else {
        prior.archive_note = next ? `No longer PASS (${next.record.verdict}).` : "Could not reprice with a model.";
        archiveSaved(root, filename, prior, etDay(now));
      }
    } catch (error) {
      errors.push(`saved ${ticker}: ${error instanceof Error ? error.message : "unavailable"}`);
    }
  }
  return kept;
}

async function loadBankroll(env: Record<string, string | undefined>, errors: string[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!keysConfigured(env)) return map;
  try {
    const rows = await readShardCash(env);
    for (const row of rows) {
      if (row.dollars != null) map.set(row.index, row.dollars);
    }
  } catch (error) {
    errors.push(`balance: ${error instanceof Error ? error.message : "unread"}`);
  }
  return map;
}

export async function serverEdgeFor(
  ticker: string,
  side: "YES" | "NO",
  price: number,
  count: number,
  get: Get = fetchJson,
): Promise<number | null> {
  const spec = CRYPTO_SERIES[seriesOf(ticker)];
  if (!spec) return null;
  const snaps = await loadAssetSnaps(new Date(), get);
  const { fetchMarket } = await import("./kalshi-public.js");
  const market = await fetchMarket(ticker, get);
  if (!market?.floor_strike || !market.close_time) return null;
  const minutes = (Date.parse(market.close_time) - Date.now()) / 60000;
  const fair = cryptoFairYes({
    snap: snaps[spec.symbol],
    strike: market.floor_strike,
    minutesLeft: minutes,
    kind: spec.kind,
    nowMs: Date.now(),
  });
  if (!fair) return null;
  const fairSide = side === "YES" ? fair.fairYes : 1 - fair.range[1];
  return edgeCents(fairSide, price, count);
}

function seriesOf(ticker: string): string {
  const match = ticker.match(/^[A-Z0-9]+/);
  const head = match?.[0] || ticker;
  if (CRYPTO_SERIES[head]) return head;
  const known = [...SPORTS_SERIES, ...Object.keys(CRYPTO_SERIES)];
  const hit = known.find((series) => ticker.startsWith(series));
  if (hit) return hit;
  const parts = ticker.split("-");
  return parts[0] || ticker;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function suggestStakeText(record: DeskRecord): string {
  if (record.model === "no model") return "no stake — no model";
  if (!record.stake_suggestion.contracts) return record.stake_suggestion.method;
  return `${record.stake_suggestion.contracts} contracts ($${record.stake_suggestion.cost_dollars.toFixed(2)})`;
}

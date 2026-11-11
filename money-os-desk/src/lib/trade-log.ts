/**
 * Trade log view model.
 * The server fills this from Kalshi and the pick feed. The browser only renders it.
 * Live Kalshi fills, positions, settlements, and the P&L derived from them replace
 * the same fields on the feed. Picks, skipped orders, and notes stay on the feed.
 */

export const TRADE_LOG_REFRESH_MS = 5 * 60 * 1000;
export const KALSHI_KEYS_MISSING = "Kalshi keys not set";
export const DEFAULT_FEED_URL =
  "https://raw.githubusercontent.com/samuelkreitl-wq/Command-Center-1/money-desk-data/data/money-desk-feed.json";

const SHARD_LABELS: Record<number, string> = {
  0: "general",
  1: "combos",
  2: "crypto and commodities",
  3: "sports",
};

export type ShardCash = { index: number; label: string; dollars: number | null };

export type PickRow = {
  id: string;
  timestamp: string;
  tab: string;
  market: string;
  ticker: string;
  side: string;
  price: number | null;
  fairProb: number | null;
  edgeCents: number | null;
  stakeDollars: number | null;
  stakeContracts: number | null;
  verdict: string;
  closeTime: string;
  notes: string;
};

export type PositionRow = {
  id: string;
  ticker: string;
  market: string;
  tab: string;
  verdict: string;
  side: string;
  contracts: number;
  avgPrice: number | null;
  mark: number | null;
  unrealized: number | null;
  shard: number | null;
  shardLabel: string;
  updated: string;
};

export type FillRow = {
  id: string;
  timestamp: string;
  ticker: string;
  market: string;
  tab: string;
  verdict: string;
  side: string;
  action: string;
  price: number | null;
  count: number | null;
  fee: number | null;
  shard: number | null;
  shardLabel: string;
  source: "kalshi" | "feed";
};

export type SkippedRow = {
  id: string;
  timestamp: string;
  tab: string;
  market: string;
  ticker: string;
  side: string;
  verdict: string;
  price: number | null;
  count: number | null;
  reason: string;
};

export type PnlDay = {
  date: string;
  realized: number | null;
  unrealized: number | null;
  total: number | null;
};

export type PnlView = {
  source: "kalshi" | "feed" | "none";
  realized: number | null;
  unrealized: number | null;
  total: number | null;
  partial: boolean;
  unmarked: number;
  note: string;
  byDay: PnlDay[];
};

export type TradeLogView = {
  refreshedAt: string;
  feed: { generatedAt: string | null; error: string | null; host: string | null };
  kalshi: { configured: boolean; error: string | null; shards: ShardCash[] };
  picksToday: PickRow[];
  positions: PositionRow[];
  pnl: PnlView;
  pickLog: PickRow[];
  fills: FillRow[];
  skipped: SkippedRow[];
};

export type TradeLogInput = {
  now: number;
  feed: unknown;
  feedError: string | null;
  feedHost: string | null;
  kalshi: {
    configured: boolean;
    error: string | null;
    shards: ShardCash[];
    fills: unknown[];
    settlements: unknown[];
    positions: unknown[];
    /** YES mark by ticker. Null means the quote was missing. */
    marks: Record<string, number | null>;
    fillsOk: boolean;
    settlementsOk: boolean;
    positionsOk: boolean;
  };
};

export function shardName(index: number | null | undefined): string {
  if (index == null || !Number.isFinite(index)) return "—";
  return SHARD_LABELS[index] || `shard ${index}`;
}

export function resolveFeedUrl(env: Record<string, string | undefined>): string {
  const configured = env.MONEY_DESK_FEED_URL?.trim();
  return configured || DEFAULT_FEED_URL;
}

export function assertFeedUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Feed URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Feed URL must be https");
  if (parsed.username || parsed.password) throw new Error("Feed URL must not include credentials");
  if (isBlockedHost(parsed.hostname)) throw new Error("Feed URL host is not allowed");
  return parsed;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function dollars(value: number): number {
  return Math.round(value * 100) / 100;
}

export function etDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

export function formatEt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour");
  const minute = pick("minute");
  const period = pick("dayPeriod").replace(/\./g, "").toUpperCase();
  if (!month || !day || !hour || !minute) return "—";
  return `${month} ${day}, ${hour}:${minute} ${period} ET`;
}

export function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const body = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${body}` : `$${body}`;
}

export function formatSignedMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value > 0) return `+${formatMoney(value)}`;
  return formatMoney(value);
}

export function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

export function formatProb(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatEdge(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  return `${cents.toFixed(1)}¢`;
}

export function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const digits = Number.isInteger(value) ? 0 : 2;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: 2 });
}

export function formatStake(dollarsAmount: number | null, contracts: number | null): string {
  if (dollarsAmount == null && contracts == null) return "—";
  if (dollarsAmount != null && contracts != null) return `${formatMoney(dollarsAmount)} · ${formatCount(contracts)}`;
  if (dollarsAmount != null) return formatMoney(dollarsAmount);
  return `${formatCount(contracts)} contracts`;
}

export function yesMark(market: {
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
} | null): number | null {
  if (!market) return null;
  const bid = asNumber(market.yes_bid_dollars);
  const ask = asNumber(market.yes_ask_dollars);
  if (bid != null && ask != null && bid > 0 && ask > 0 && bid < 1 && ask < 1 && ask >= bid) {
    return (bid + ask) / 2;
  }
  const last = asNumber(market.last_price_dollars);
  if (last != null && last > 0 && last < 1) return last;
  if (bid != null && bid > 0 && bid < 1) return bid;
  if (ask != null && ask > 0 && ask < 1) return ask;
  return null;
}

/** Signed contracts: positive YES, negative NO. `yes` is the YES mark, 0–1. */
export function markToMarket(positionFp: number, exposure: number | null, yes: number | null): number | null {
  if (!Number.isFinite(positionFp) || positionFp === 0 || exposure == null || yes == null) return null;
  if (yes < 0 || yes > 1) return null;
  const mark = positionFp > 0 ? yes : 1 - yes;
  return dollars(Math.abs(positionFp) * mark - exposure);
}

export function settlementPnl(row: Record<string, unknown>): number | null {
  const revenue = revenueDollars(row);
  if (revenue == null) return null;
  const yesCost = dollarField(row, "yes_total_cost_dollars", "yes_total_cost");
  const noCost = dollarField(row, "no_total_cost_dollars", "no_total_cost");
  const fee = dollarOrNull(row.fee_cost, null) ?? dollarOrNull(row.fee_cost_dollars, null) ?? 0;
  return dollars(revenue - yesCost - noCost - fee);
}

export function parseShards(body: unknown): ShardCash[] {
  const payload = record(body);
  if (!payload) return [];
  const rows = Array.isArray(payload.balance_breakdown) ? payload.balance_breakdown : [];
  if (rows.length) {
    return rows.slice(0, 16).map((row) => {
      const rec = record(row);
      const index = asNumber(rec?.exchange_index);
      const safe = index == null || index < 0 ? 0 : index;
      return { index: safe, label: shardName(safe), dollars: dollarOrNull(rec?.balance_dollars, rec?.balance) };
    });
  }
  if ("balance" in payload || "balance_dollars" in payload) {
    return [{ index: 0, label: shardName(0), dollars: dollarOrNull(payload.balance_dollars, payload.balance) }];
  }
  return [];
}

/** Null when the payload does not list shards. Callers then read the portfolio unscoped. */
export function shardIndexes(body: unknown): number[] | null {
  const payload = record(body);
  const rows = payload && Array.isArray(payload.balance_breakdown) ? payload.balance_breakdown : [];
  if (!rows.length) return null;
  const indexes: number[] = [];
  for (const row of rows.slice(0, 16)) {
    const index = asNumber(record(row)?.exchange_index);
    if (index != null && index >= 0 && index <= 32 && !indexes.includes(index)) indexes.push(index);
  }
  return indexes;
}

export function tickersFromPositions(rows: unknown[]): string[] {
  const tickers: string[] = [];
  for (const row of rows) {
    const rec = record(row);
    const ticker = clip(rec?.ticker, 80);
    const fp = asNumber(rec?.position_fp);
    if (ticker && fp != null && fp !== 0 && !tickers.includes(ticker)) tickers.push(ticker);
  }
  return tickers;
}

export function buildTradeLog(input: TradeLogInput): TradeLogView {
  const feed = parseFeed(input.feed);
  const feedError = input.feedError || feed.error;
  const pickLog = feed.pickLog.slice().sort(byTimeDesc);
  const todayKey = etDay(new Date(input.now).toISOString());
  const picksToday = feed.picksTodayExplicit
    ? feed.picksToday
    : pickLog.filter((pick) => etDay(pick.timestamp) === todayKey);
  const catalog = latestByTicker([...pickLog, ...picksToday]);

  const kalshiFills = input.kalshi.fillsOk ? dedupeFills(input.kalshi.fills.map((row) => normalizeKalshiFill(row, catalog)).filter(isFill)) : [];
  const feedFills = dedupeFills(feed.fills.map((row) => normalizeFeedFill(row, catalog)).filter(isFill));
  const fills = (input.kalshi.fillsOk ? kalshiFills : feedFills).sort(byTimeDesc);

  const skipped = dedupeSkipped(feed.skipped).sort(byTimeDesc);
  const positions = input.kalshi.positionsOk
    ? input.kalshi.positions
      .map((row) => normalizePosition(row, input.kalshi.marks, catalog))
      .filter((row): row is PositionRow => row != null)
      .sort((a, b) => Math.abs(b.unrealized ?? 0) - Math.abs(a.unrealized ?? 0) || a.ticker.localeCompare(b.ticker))
    : [];

  const pnl = buildPnl(input, feed.pnl, positions);

  return {
    refreshedAt: new Date(input.now).toISOString(),
    feed: { generatedAt: feed.generatedAt, error: feedError, host: input.feedHost },
    kalshi: {
      configured: input.kalshi.configured,
      error: input.kalshi.configured ? input.kalshi.error : KALSHI_KEYS_MISSING,
      shards: input.kalshi.configured ? input.kalshi.shards : [],
    },
    picksToday,
    positions,
    pnl,
    pickLog,
    fills,
    skipped,
  };
}

function buildPnl(input: TradeLogInput, feedPnl: PnlView | null, positions: PositionRow[]): PnlView {
  const kalshiReady = input.kalshi.configured && (input.kalshi.settlementsOk || input.kalshi.positionsOk);
  if (!kalshiReady) {
    if (feedPnl) {
      return {
        ...feedPnl,
        source: "feed",
        note: input.kalshi.configured
          ? "Kalshi did not return settlements or positions, so this P&L is the pick feed."
          : "Kalshi keys are not set, so this P&L is the pick feed. It is not a live mark.",
      };
    }
    return emptyPnl(input.kalshi.configured
      ? "Kalshi did not return a P&L, and the pick feed has none either."
      : "Kalshi keys are not set, and the pick feed has no P&L.");
  }

  const settlementRows = input.kalshi.settlementsOk ? input.kalshi.settlements : [];
  let unparsed = 0;
  const realizedRows: { day: string; pnl: number }[] = [];
  for (const row of settlementRows) {
    const rec = record(row);
    if (!rec) {
      unparsed += 1;
      continue;
    }
    const pnl = settlementPnl(rec);
    if (pnl == null) {
      unparsed += 1;
      continue;
    }
    const day = etDay(asIso(rec.settled_time) || asIso(rec.ts));
    realizedRows.push({ day, pnl });
  }
  const realized = dollars(realizedRows.reduce((sum, row) => sum + row.pnl, 0));
  const open = positions.filter((row) => row.contracts !== 0);
  const known = open.map((row) => row.unrealized).filter((value): value is number => value != null);
  const unmarked = open.length - known.length;
  let unrealized: number | null = null;
  if (input.kalshi.positionsOk) unrealized = open.length === 0 ? 0 : known.length ? dollars(known.reduce((sum, value) => sum + value, 0)) : null;
  const partial = unmarked > 0 || unparsed > 0 || !input.kalshi.settlementsOk || !input.kalshi.positionsOk;
  const total = input.kalshi.settlementsOk && unrealized != null && unmarked === 0 && unparsed === 0
    ? dollars(realized + unrealized)
    : null;
  const byDayMap = new Map<string, number>();
  for (const row of realizedRows) {
    if (!row.day) continue;
    byDayMap.set(row.day, dollars((byDayMap.get(row.day) ?? 0) + row.pnl));
  }
  const byDay = [...byDayMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, dayRealized]) => ({ date, realized: dayRealized, unrealized: null, total: dayRealized }));
  const notes = [
    "Realized is Kalshi settlement payout minus cost and fees. Unrealized is the open mark minus the cost basis.",
  ];
  if (!input.kalshi.settlementsOk) notes.push("Settlements did not load.");
  if (!input.kalshi.positionsOk) notes.push("Positions did not load.");
  if (unparsed) notes.push(`${unparsed} settlement ${unparsed === 1 ? "row was" : "rows were"} left out because revenue was missing.`);
  if (unmarked) notes.push(`${unmarked} open ${unmarked === 1 ? "position has" : "positions have"} no quote, so the total is withheld.`);
  return {
    source: "kalshi",
    realized: input.kalshi.settlementsOk ? realized : null,
    unrealized,
    total: input.kalshi.settlementsOk ? total : null,
    partial,
    unmarked,
    note: notes.join(" "),
    byDay,
  };
}

function emptyPnl(note: string): PnlView {
  return { source: "none", realized: null, unrealized: null, total: null, partial: false, unmarked: 0, note, byDay: [] };
}

type FeedParse = {
  error: string | null;
  generatedAt: string | null;
  picksTodayExplicit: boolean;
  picksToday: PickRow[];
  pickLog: PickRow[];
  fills: unknown[];
  skipped: unknown[];
  pnl: PnlView | null;
};

function parseFeed(feed: unknown): FeedParse {
  const empty: FeedParse = {
    error: null,
    generatedAt: null,
    picksTodayExplicit: false,
    picksToday: [],
    pickLog: [],
    fills: [],
    skipped: [],
    pnl: null,
  };
  if (feed == null) return empty;
  const payload = record(feed);
  if (!payload) return { ...empty, error: "Feed was not a JSON object" };
  const pickLog = readPicks(payload.pick_log);
  const explicit = "picks_today" in payload;
  const nestedFills: unknown[] = [];
  const nestedSkipped: unknown[] = [];
  for (const source of [payload.pick_log, payload.picks_today]) {
    if (!Array.isArray(source)) continue;
    for (const row of source) {
      const rec = record(row);
      if (!rec) continue;
      nestedFills.push(...childRows(rec, "fills"));
      nestedSkipped.push(...childRows(rec, "skipped"));
    }
  }
  if (Array.isArray(payload.fills)) nestedFills.push(...payload.fills);
  if (Array.isArray(payload.skipped)) nestedSkipped.push(...payload.skipped);
  return {
    error: null,
    generatedAt: asIso(payload.generated_at),
    picksTodayExplicit: explicit,
    picksToday: explicit ? readPicks(payload.picks_today) : [],
    pickLog,
    fills: nestedFills,
    skipped: nestedSkipped,
    pnl: readFeedPnl(payload.pnl),
  };
}

function childRows(parent: Record<string, unknown>, key: "fills" | "skipped"): unknown[] {
  if (!Array.isArray(parent[key])) return [];
  return parent[key].map((child) => {
    const rec = record(child);
    if (!rec) return child;
    return {
      ...rec,
      ticker: rec.ticker || parent.ticker,
      market: rec.market || parent.market,
      tab: rec.tab || parent.tab,
      verdict: rec.verdict || parent.verdict,
      side: rec.side || parent.side,
    };
  });
}

function readPicks(value: unknown): PickRow[] {
  if (!Array.isArray(value)) return [];
  const nextId = ids("pick");
  const rows: PickRow[] = [];
  for (const row of value) {
    const rec = record(row);
    if (!rec) continue;
    const market = marketTitle(rec.market) || clip(rec.title, 180);
    const ticker = clip(rec.ticker, 80) || tickerFromMarket(rec.market);
    if (!market && !ticker) continue;
    const stake = readStake(rec.stake ?? rec.stake_suggestion);
    rows.push({
      id: nextId(clip(rec.id, 80) || `${ticker}|${asIso(rec.timestamp) || asIso(rec.created_at) || rows.length}`),
      timestamp: asIso(rec.timestamp) || asIso(rec.created_at) || "",
      tab: clip(rec.tab, 40),
      market: market || ticker,
      ticker,
      side: sideOf(rec.side),
      price: contractPrice(rec.price),
      fairProb: probability(rec.fair_prob),
      edgeCents: readEdge(rec.edge),
      stakeDollars: stake.dollars,
      stakeContracts: stake.contracts,
      verdict: verdictOf(rec.verdict),
      closeTime: asIso(rec.close_time) || asIso(rec.close_time_et) || "",
      notes: clip(rec.notes ?? rec.note, 500),
    });
  }
  return rows;
}

function readFeedPnl(value: unknown): PnlView | null {
  const rec = record(value);
  if (!rec) return null;
  const realized = asNumber(rec.realized);
  const unrealized = asNumber(rec.unrealized);
  const total = asNumber(rec.total);
  const byDay = Array.isArray(rec.by_day)
    ? rec.by_day.flatMap((row) => {
      const day = record(row);
      const date = clip(day?.date, 10);
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      const dayRealized = asNumber(day.realized);
      const dayUnrealized = asNumber(day.unrealized);
      const dayTotal = asNumber(day.total);
      return [{ date, realized: dayRealized, unrealized: dayUnrealized, total: dayTotal }];
    }).sort((a, b) => b.date.localeCompare(a.date))
    : [];
  if (realized == null && unrealized == null && total == null && !byDay.length) return null;
  return {
    source: "feed",
    realized,
    unrealized,
    total,
    partial: false,
    unmarked: 0,
    note: "",
    byDay,
  };
}

function normalizeKalshiFill(row: unknown, catalog: Map<string, PickRow>): FillRow | null {
  const rec = record(row);
  if (!rec) return null;
  const ticker = clip(rec.ticker, 80) || clip(rec.market_ticker, 80);
  if (!ticker) return null;
  const side = sideOf(rec.outcome_side ?? rec.side);
  const yes = contractPrice(rec.yes_price_dollars ?? rec.yes_price);
  const no = contractPrice(rec.no_price_dollars ?? rec.no_price);
  const price = side === "NO" ? (no ?? (yes == null ? null : dollars(1 - yes))) : (yes ?? no);
  const actionRaw = clip(rec.action, 16).toLowerCase();
  const action = actionRaw === "buy" || actionRaw === "sell"
    ? actionRaw
    : rec.is_taker === true
      ? "taker"
      : rec.is_taker === false
        ? "maker"
        : "";
  const shard = asNumber(rec.exchange_index);
  const pick = catalog.get(ticker);
  const timestamp = asIso(rec.created_time) || asIso(rec.created_ts) || asIso(rec.ts) || "";
  return {
    id: clip(rec.fill_id, 80) || clip(rec.trade_id, 80) || `${ticker}|${timestamp}|${side}|${asNumber(rec.count_fp) ?? ""}`,
    timestamp,
    ticker,
    market: pick?.market || ticker,
    tab: pick?.tab || "",
    verdict: pick?.verdict || "",
    side,
    action,
    price,
    count: asNumber(rec.count_fp) ?? asNumber(rec.count),
    fee: dollarOrNull(rec.fee_cost, null),
    shard: shard == null ? null : shard,
    shardLabel: shardName(shard),
    source: "kalshi",
  };
}

function normalizeFeedFill(row: unknown, catalog: Map<string, PickRow>): FillRow | null {
  const rec = record(row);
  if (!rec) return null;
  const ticker = clip(rec.ticker, 80);
  if (!ticker && !clip(rec.market, 80)) return null;
  const pick = ticker ? catalog.get(ticker) : undefined;
  const shard = asNumber(rec.exchange_index);
  const timestamp = asIso(rec.timestamp) || asIso(rec.created_time) || "";
  const side = sideOf(rec.side);
  return {
    id: clip(rec.fill_id, 80) || `${ticker}|${timestamp}|${side}|${asNumber(rec.count) ?? ""}`,
    timestamp,
    ticker,
    market: marketTitle(rec.market) || pick?.market || ticker,
    tab: clip(rec.tab, 40) || pick?.tab || "",
    verdict: verdictOf(rec.verdict) || pick?.verdict || "",
    side,
    action: clip(rec.action, 16).toLowerCase(),
    price: contractPrice(rec.price),
    count: asNumber(rec.count) ?? asNumber(rec.count_fp),
    fee: dollarOrNull(rec.fee, rec.fee_cost),
    shard: shard == null ? null : shard,
    shardLabel: shardName(shard),
    source: "feed",
  };
}

function normalizePosition(row: unknown, marks: Record<string, number | null>, catalog: Map<string, PickRow>): PositionRow | null {
  const rec = record(row);
  if (!rec) return null;
  const ticker = clip(rec.ticker, 80);
  const fp = asNumber(rec.position_fp);
  if (!ticker || fp == null || fp === 0) return null;
  const contracts = Math.abs(fp);
  const exposure = dollarOrNull(rec.market_exposure_dollars, rec.market_exposure);
  const yes = Object.prototype.hasOwnProperty.call(marks, ticker) ? marks[ticker] : null;
  const sideMark = yes == null ? null : fp > 0 ? yes : 1 - yes;
  const unrealized = markToMarket(fp, exposure, yes);
  const shard = asNumber(rec.exchange_index);
  const pick = catalog.get(ticker);
  return {
    id: `${ticker}|${shard ?? "na"}`,
    ticker,
    market: pick?.market || ticker,
    tab: pick?.tab || (shard == null ? "" : shardName(shard)),
    verdict: pick?.verdict || "",
    side: fp > 0 ? "YES" : "NO",
    contracts,
    avgPrice: exposure == null || contracts === 0 ? null : dollars(exposure / contracts),
    mark: sideMark == null ? null : sideMark,
    unrealized,
    shard: shard == null ? null : shard,
    shardLabel: shardName(shard),
    updated: asIso(rec.last_updated_ts) || "",
  };
}

function latestByTicker(picks: PickRow[]): Map<string, PickRow> {
  const map = new Map<string, PickRow>();
  for (const pick of picks) {
    if (!pick.ticker) continue;
    const prev = map.get(pick.ticker);
    if (!prev || (pick.timestamp && pick.timestamp > prev.timestamp)) map.set(pick.ticker, pick);
  }
  return map;
}

function dedupeFills(rows: FillRow[]): FillRow[] {
  const seen = new Set<string>();
  const out: FillRow[] = [];
  for (const row of rows) {
    const key = row.id || `${row.ticker}|${row.timestamp}|${row.side}|${row.count}|${row.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, id: key });
  }
  return out;
}

function dedupeSkipped(rows: unknown[]): SkippedRow[] {
  const seen = new Set<string>();
  const nextId = ids("skip");
  const out: SkippedRow[] = [];
  for (const row of rows) {
    const rec = record(row);
    if (!rec) continue;
    const ticker = clip(rec.ticker, 80);
    const market = marketTitle(rec.market) || clip(rec.market, 180);
    const reason = clip(rec.reason ?? rec.notes ?? rec.note, 500);
    if (!ticker && !market && !reason) continue;
    const timestamp = asIso(rec.timestamp) || asIso(rec.created_time) || "";
    const side = sideOf(rec.side);
    const key = `${timestamp}|${ticker}|${side}|${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: nextId(key),
      timestamp,
      tab: clip(rec.tab, 40),
      market: market || ticker,
      ticker,
      side,
      verdict: verdictOf(rec.verdict),
      price: contractPrice(rec.price),
      count: asNumber(rec.count),
      reason,
    });
  }
  return out;
}

function isFill(row: FillRow | null): row is FillRow {
  return row != null;
}

function readEdge(value: unknown): number | null {
  const rec = record(value);
  if (rec) return asNumber(rec.cents_per_contract_after_fees);
  return asNumber(value);
}

function readStake(value: unknown): { dollars: number | null; contracts: number | null } {
  const rec = record(value);
  if (rec) return { dollars: dollarOrNull(rec.cost_dollars ?? rec.dollars, null), contracts: asNumber(rec.contracts) };
  return { dollars: asNumber(value), contracts: null };
}

function marketTitle(value: unknown): string {
  if (typeof value === "string") return clip(value, 180);
  const rec = record(value);
  return clip(rec?.title, 180);
}

function tickerFromMarket(value: unknown): string {
  return clip(record(value)?.ticker, 80);
}

function revenueDollars(row: Record<string, unknown>): number | null {
  const dollarsValue = dollarOrNull(row.revenue_dollars, null);
  if (dollarsValue != null) return dollarsValue;
  const cents = asNumber(row.revenue);
  return cents == null ? null : cents / 100;
}

function dollarField(row: Record<string, unknown>, dollarsKey: string, centsKey: string): number {
  return dollarOrNull(row[dollarsKey], row[centsKey]) ?? 0;
}

function dollarOrNull(dollarsValue: unknown, cents: unknown): number | null {
  const direct = asNumber(dollarsValue);
  if (direct != null) return direct;
  const fromCents = asNumber(cents);
  if (fromCents != null) return fromCents / 100;
  return null;
}

function contractPrice(value: unknown): number | null {
  const n = asNumber(value);
  if (n == null) return null;
  if (n >= 0 && n <= 1) return n;
  if (n > 1 && n <= 100) return Math.round(n) / 100;
  return null;
}

function probability(value: unknown): number | null {
  const n = asNumber(value);
  if (n == null) return null;
  if (n >= 0 && n <= 1) return n;
  if (n > 1 && n <= 100) return n / 100;
  return null;
}

function sideOf(value: unknown): string {
  const raw = clip(value, 16).toUpperCase();
  if (raw === "YES" || raw === "Y") return "YES";
  if (raw === "NO" || raw === "N") return "NO";
  return raw;
}

function verdictOf(value: unknown): string {
  return clip(value, 24).toUpperCase();
}

export function asIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const clean = String(value).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ids(prefix: string): (seed: string) => string {
  const seen = new Set<string>();
  return (seed: string) => {
    const base = `${prefix}:${seed || "row"}`;
    let id = base;
    let n = 2;
    while (seen.has(id)) {
      id = `${base}:${n}`;
      n += 1;
    }
    seen.add(id);
    return id;
  };
}

function byTimeDesc(a: { timestamp: string }, b: { timestamp: string }): number {
  const at = Date.parse(a.timestamp);
  const bt = Date.parse(b.timestamp);
  return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "metadata.google.internal") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (host.includes(":")) {
    return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  }
  return false;
}

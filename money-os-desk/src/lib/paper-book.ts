/**
 * 24/7 paper book. It uses the desk's strike-post, minute-5 MISSED, and minute-10
 * rules (imported, not rewritten) and a separate paper ledger.
 *
 * Minute-10 rule: inside the one allowed tick, if callVsStrike flips the effective
 * call, the open paper position is closed at the held side's bid (taker fee) and,
 * when the new call is UP or DOWN, one replacement is opened at that side's ask.
 * AT STRIKE closes flat. A second change is refused and the position is left as it is.
 * The safety banner is recorded and never closes a position.
 * A resting limit fills only through the shared limit rule. A stop stored on the
 * position can close it through the shared stop rule. Neither path signs an order.
 *
 * ISOLATION: this module does not sign requests and does not import the live executor.
 */

import { callVsStrike } from "./engine";
import { CALL_DEADLINE_MS, DESK_POLL_MS, isFreshSpotTick, tenMinuteTick } from "./desk";
import { exitPnl, settlementPnl, takerFeeDollars } from "./kalshi-fees";
import { etDateKey, zonedParts } from "./et-time";
import { windowId } from "./signal-lock";
import { evaluateLimit, evaluateStop, quoteIsStale, type StopSpec } from "./risk";
import type { Direction, SpotTick } from "./types";

export const GAP_MS = 20 * 60 * 1000;

export type PaperDirection = "UP" | "DOWN";

export type FrameReading = {
  id: string;
  direction: string | null;
  stale: boolean;
  known?: boolean;
  reconstructed?: boolean;
};

export type ConflictFlag = {
  id: string;
  pattern: string;
  known: boolean;
  reconstructed?: boolean;
};

export type PaperEntry = {
  kind: "entry";
  id: string;
  ts: number;
  ticker: string;
  openTime: string;
  closeTime: string;
  direction: PaperDirection;
  side: "yes" | "no";
  strike: number;
  entry: number;
  bid: number | null;
  ask: number;
  spread: number | null;
  contracts: number;
  fees: number;
  path: "aligned" | "conflict";
  frames: FrameReading[];
  conflicts?: ConflictFlag[];
  projection: unknown;
  forecast: unknown;
  forecastProbability?: number | null;
  safety: "none" | "watch" | "danger";
  lockCall: Direction | null;
  proposalId: string;
  stop?: StopSpec | null;
  source?: "paper" | "recorded";
  reconstructed?: boolean;
  title?: string;
  note?: string;
};

export type PaperExit = {
  kind: "exit";
  id: string;
  ts: number;
  ticker: string;
  entryId: string;
  exit: number;
  fees: number;
  pnl: number;
  reason: "minute10" | "stop" | "limit";
  stopReason?: string | null;
};

export type PaperSettlement = {
  kind: "settlement";
  id: string;
  ts: number;
  ticker: string;
  entryId: string;
  result: "yes" | "no";
  settlementPrice: number;
  fees: number;
  pnl: number;
  correct: boolean;
  expirationValue?: string;
  source?: "paper" | "recorded";
  note?: string;
};

export type PaperLimit = {
  kind: "limit";
  id: string;
  ts: number;
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  limit: number;
  count: number;
  expiresAt: number;
  closeTime: string;
  openTime: string;
  direction: PaperDirection;
  strike: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  path: "aligned" | "conflict";
  frames: FrameReading[];
  conflicts?: ConflictFlag[];
  projection: unknown;
  forecast: unknown;
  forecastProbability?: number | null;
  safety: "none" | "watch" | "danger";
  lockCall: Direction | null;
  stop: StopSpec | null;
  source: "paper" | "recorded";
  title?: string;
  note?: string;
  reconstructed?: boolean;
  exitReason?: "stop" | "limit";
  stopReason?: string | null;
};

export type PaperLimitEnd = {
  kind: "limit_end";
  id: string;
  ts: number;
  ticker: string;
  limitId: string;
  status: "filled" | "cancelled" | "expired";
  fillPrice: number | null;
};

export type PaperMiss = { kind: "missed"; id: string; ts: number; ticker: string; openTime: string; closeTime: string; reason: string };
export type PaperGap = { kind: "gap"; id: string; ts: number; from: number; to: number; reason: string };
export type PaperSkip = { kind: "skip"; id: string; ts: number; ticker: string; reason: string };
export type PaperRefusal = { kind: "refusal"; id: string; ts: number; ticker: string; reason: string };

export type PaperRow = PaperEntry | PaperExit | PaperSettlement | PaperMiss | PaperGap | PaperSkip | PaperRefusal | PaperLimit | PaperLimitEnd;

export type Watch = {
  windowId: string;
  ticker: string;
  openTime: string;
  closeTime: string;
  phase: "awaiting" | "locked" | "missed";
  lockedCall: Direction | null;
  revisedCall?: Direction;
  revision?: { at: number; from: Direction; to: Direction; reason: string };
  revisionRefusal?: { at: number; attempted: Direction; reason: string };
  strike: number | null;
  lockedAt: number;
  startPx: number;
  skipNoted?: boolean;
};

export type MarketSnap = {
  ticker: string;
  openTime?: string;
  closeTime: string;
  strike: number | null;
  status: string;
  result?: string;
  expirationValue?: string;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  quoteTs?: number | null;
  quoteStale?: boolean;
};

export type PaperDecision = {
  side: "yes" | "no" | null;
  count: number;
  bid: number | null;
  ask: number | null;
  path: "aligned" | "conflict";
  frames: { id: string; direction: string | null; stale: boolean }[];
  projection: unknown;
  forecast: unknown;
  safety: "none" | "watch" | "danger";
  limit?: number | null;
  stop?: StopSpec | null;
  conflicts?: ConflictFlag[];
};

export type OpenPaper = {
  ticker: string;
  entryId: string;
  side: "yes" | "no";
  count: number;
  entry: number;
  fee: number;
  stop: StopSpec | null;
};

let seq = 0;
function nid(prefix: string, now: number): string {
  seq += 1;
  return `${prefix}_${now}_${seq}`;
}

export function openPositions(rows: PaperRow[]): Record<string, OpenPaper> {
  const map: Record<string, OpenPaper> = {};
  for (const row of rows) {
    if (row.kind === "entry") {
      map[row.ticker] = { ticker: row.ticker, entryId: row.id, side: row.side, count: row.contracts, entry: row.entry, fee: row.fees, stop: row.stop ?? null };
    } else if (row.kind === "exit" || row.kind === "settlement") {
      const open = Object.values(map).find((pos) => pos.entryId === row.entryId);
      if (open) delete map[open.ticker];
    }
  }
  return map;
}

export function advancePaper(opts: {
  rows: PaperRow[];
  watches: Record<string, Watch>;
  lastPollAt: number | null;
  now: number;
  markets: MarketSnap[];
  spot: SpotTick | null;
  decisionFor: (market: MarketSnap, watch: Watch) => PaperDecision | null;
}): { watches: Record<string, Watch>; rows: PaperRow[]; lastPollAt: number } {
  const rows = [...opts.rows];
  const created: PaperRow[] = [];
  const watches = { ...opts.watches };
  const push = (row: PaperRow) => {
    rows.push(row);
    created.push(row);
  };
  if (opts.lastPollAt != null && opts.now - opts.lastPollAt > GAP_MS) {
    push({ kind: "gap", id: nid("gap", opts.now), ts: opts.now, from: opts.lastPollAt, to: opts.now, reason: "The paper trader was down across this span. Windows in the gap were not watched." });
  }
  resolveResting(rows, push, opts.markets, opts.now);
  applyStops(rows, push, opts.markets, opts.now);
  for (const market of opts.markets) {
    if (!market.openTime) continue;
    const id = windowId(market.ticker, market.closeTime);
    if (Date.parse(market.closeTime) <= opts.now) {
      settleIfFinal(rows, push, market, opts.now);
      continue;
    }
    const existing = watches[id] ?? null;
    const stepped = stepWatch(existing, market, opts.spot, opts.now);
    watches[id] = stepped.watch;
    if (stepped.event === "missed") {
      push({ kind: "missed", id: nid("miss", opts.now), ts: opts.now, ticker: market.ticker, openTime: market.openTime, closeTime: market.closeTime, reason: stepped.reason });
    }
    if (stepped.event === "revised" && stepped.flippedTo) {
      reversePosition(rows, push, market, stepped.flippedTo, opts.now);
    } else if (stepped.event === "revision_refused") {
      push({ kind: "refusal", id: nid("refuse", opts.now), ts: opts.now, ticker: market.ticker, reason: "Second minute-10 change refused. The paper position was left unchanged." });
    }
    if ((stepped.event === "locked" || stepped.event === "unchanged") && stepped.watch.phase === "locked" && !openPositions(rows)[market.ticker] && !stoppedOut(rows, market.ticker) && !restingLimits(rows).some((limit) => limit.ticker === market.ticker)) {
      maybeEnter(rows, push, market, stepped.watch, opts);
    }
  }
  resolveResting(rows, push, opts.markets, opts.now);
  applyStops(rows, push, opts.markets, opts.now);
  return { watches, rows: created, lastPollAt: opts.now };
}

export function restingLimits(rows: PaperRow[]): PaperLimit[] {
  const ended = new Set(rows.filter((row): row is PaperLimitEnd => row.kind === "limit_end").map((row) => row.limitId));
  return rows.filter((row): row is PaperLimit => row.kind === "limit" && !ended.has(row.id));
}

export function cancelPaperLimit(rows: PaperRow[], limitId: string, now: number): PaperLimitEnd | null {
  const limit = restingLimits(rows).find((row) => row.id === limitId);
  if (!limit) return null;
  return { kind: "limit_end", id: nid("lend", now), ts: now, ticker: limit.ticker, limitId, status: "cancelled", fillPrice: null };
}

function stoppedOut(rows: PaperRow[], ticker: string): boolean {
  return rows.some((row) => row.kind === "exit" && row.ticker === ticker && row.reason === "stop");
}

function sideQuote(market: MarketSnap, side: "yes" | "no") {
  return side === "yes" ? { bid: market.yesBid, ask: market.yesAsk } : { bid: market.noBid, ask: market.noAsk };
}

function marketIsStale(market: MarketSnap, now: number): boolean {
  if (market.quoteStale) return true;
  if (market.quoteTs == null) return false;
  return quoteIsStale(market.quoteTs, now);
}

function probabilityOf(forecast: unknown): number | null {
  const value = forecast && typeof forecast === "object" ? (forecast as { probabilityAbove?: unknown }).probabilityAbove : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function limitOrder(input: {
  now: number;
  market: MarketSnap;
  side: "yes" | "no";
  limit: number;
  count: number;
  direction: PaperDirection;
  strike: number;
  bid: number | null;
  ask: number | null;
  path: "aligned" | "conflict";
  frames: FrameReading[];
  conflicts?: ConflictFlag[];
  projection: unknown;
  forecast: unknown;
  safety: "none" | "watch" | "danger";
  lockCall: Direction | null;
  stop: StopSpec | null;
  action?: "buy" | "sell";
  exitReason?: "stop" | "limit";
  stopReason?: string | null;
}): PaperLimit {
  return {
    kind: "limit",
    id: nid("limit", input.now),
    ts: input.now,
    ticker: input.market.ticker,
    action: input.action ?? "buy",
    side: input.side,
    limit: input.limit,
    count: input.count,
    expiresAt: Date.parse(input.market.closeTime),
    closeTime: input.market.closeTime,
    openTime: input.market.openTime || "",
    direction: input.direction,
    strike: input.strike,
    bid: input.bid,
    ask: input.ask,
    spread: input.bid == null || input.ask == null ? null : input.ask - input.bid,
    path: input.path,
    frames: input.frames,
    conflicts: input.conflicts,
    projection: input.projection,
    forecast: input.forecast,
    forecastProbability: probabilityOf(input.forecast),
    safety: input.safety,
    lockCall: input.lockCall,
    stop: input.stop,
    source: "paper",
    exitReason: input.exitReason,
    stopReason: input.stopReason,
  };
}

function entryFromLimit(limit: PaperLimit, fill: number, now: number): PaperEntry {
  return {
    kind: "entry",
    id: nid("entry", now),
    ts: now,
    ticker: limit.ticker,
    openTime: limit.openTime,
    closeTime: limit.closeTime,
    direction: limit.direction,
    side: limit.side,
    strike: limit.strike,
    entry: fill,
    bid: limit.bid,
    ask: limit.ask ?? fill,
    spread: limit.spread,
    contracts: limit.count,
    fees: takerFeeDollars(fill, limit.count),
    path: limit.path,
    frames: limit.frames,
    conflicts: limit.conflicts,
    projection: limit.projection,
    forecast: limit.forecast,
    forecastProbability: limit.forecastProbability ?? probabilityOf(limit.forecast),
    safety: limit.safety,
    lockCall: limit.lockCall,
    proposalId: `paper_${limit.id}`,
    stop: limit.stop,
    source: limit.source,
    reconstructed: limit.reconstructed,
    title: limit.title,
    note: limit.note,
  };
}

function resolveResting(rows: PaperRow[], push: (row: PaperRow) => void, markets: MarketSnap[], now: number) {
  const byTicker = new Map(markets.map((market) => [market.ticker, market]));
  for (const limit of restingLimits(rows)) {
    if (Number.isFinite(limit.expiresAt) && now >= limit.expiresAt) {
      push({ kind: "limit_end", id: nid("lend", now), ts: now, ticker: limit.ticker, limitId: limit.id, status: "expired", fillPrice: null });
      continue;
    }
    const market = byTicker.get(limit.ticker);
    if (!market || marketIsStale(market, now)) continue;
    const quote = sideQuote(market, limit.side);
    const decision = evaluateLimit(
      { action: limit.action, limit: limit.limit, cancelled: false, expiresAt: limit.expiresAt },
      { bid: quote.bid > 0 ? quote.bid : null, ask: quote.ask > 0 ? quote.ask : null },
      now,
    );
    if (decision.status !== "filled" || decision.fillPrice == null) continue;
    push({ kind: "limit_end", id: nid("lend", now), ts: now, ticker: limit.ticker, limitId: limit.id, status: "filled", fillPrice: decision.fillPrice });
    if (limit.action === "buy") {
      if (openPositions(rows)[limit.ticker]) continue;
      push(entryFromLimit(limit, decision.fillPrice, now));
      continue;
    }
    const open = openPositions(rows)[limit.ticker];
    if (!open || open.side !== limit.side) continue;
    const exitFee = takerFeeDollars(decision.fillPrice, open.count);
    push({
      kind: "exit",
      id: nid("exit", now),
      ts: now,
      ticker: limit.ticker,
      entryId: open.entryId,
      exit: decision.fillPrice,
      fees: exitFee,
      pnl: exitPnl({ count: open.count, entry: open.entry, entryFee: open.fee, exit: decision.fillPrice, exitFee }),
      reason: limit.exitReason ?? "limit",
      stopReason: limit.stopReason ?? null,
    });
  }
}

function applyStops(rows: PaperRow[], push: (row: PaperRow) => void, markets: MarketSnap[], now: number) {
  for (const market of markets) {
    if (Date.parse(market.closeTime) <= now) continue;
    const open = openPositions(rows)[market.ticker];
    if (!open?.stop) continue;
    const quote = sideQuote(market, open.side);
    const mark = quote.bid > 0 && quote.bid < 1 ? quote.bid : null;
    const decision = evaluateStop({
      entry: open.entry,
      count: open.count,
      mark,
      stop: open.stop,
      stale: marketIsStale(market, now),
      alreadyFired: false,
    });
    if (!decision.fire || decision.price == null || decision.reason == null) continue;
    const fill = evaluateLimit(
      { action: "sell", limit: decision.price, cancelled: false, expiresAt: Date.parse(market.closeTime) },
      { bid: mark, ask: quote.ask > 0 ? quote.ask : null },
      now,
    );
    if (fill.status !== "filled" || fill.fillPrice == null) continue;
    const entry = rows.find((row): row is PaperEntry => row.kind === "entry" && row.id === open.entryId);
    const limit = limitOrder({
      now,
      market,
      side: open.side,
      limit: decision.price,
      count: open.count,
      direction: open.side === "yes" ? "UP" : "DOWN",
      strike: entry?.strike ?? market.strike ?? 0,
      bid: quote.bid,
      ask: quote.ask,
      path: entry?.path ?? "aligned",
      frames: entry?.frames ?? [],
      conflicts: entry?.conflicts,
      projection: entry?.projection ?? null,
      forecast: entry?.forecast ?? null,
      safety: entry?.safety ?? "none",
      lockCall: entry?.lockCall ?? null,
      stop: null,
      action: "sell",
      exitReason: "stop",
      stopReason: decision.reason,
    });
    push(limit);
    push({ kind: "limit_end", id: nid("lend", now), ts: now, ticker: market.ticker, limitId: limit.id, status: "filled", fillPrice: fill.fillPrice });
    const exitFee = takerFeeDollars(fill.fillPrice, open.count);
    push({
      kind: "exit",
      id: nid("exit", now),
      ts: now,
      ticker: market.ticker,
      entryId: open.entryId,
      exit: fill.fillPrice,
      fees: exitFee,
      pnl: exitPnl({ count: open.count, entry: open.entry, entryFee: open.fee, exit: fill.fillPrice, exitFee }),
      reason: "stop",
      stopReason: decision.reason,
    });
  }
}

function maybeEnter(rows: PaperRow[], push: (row: PaperRow) => void, market: MarketSnap, watch: Watch, opts: { now: number; decisionFor: (market: MarketSnap, watch: Watch) => PaperDecision | null }) {
  if (openPositions(rows)[market.ticker] || watch.skipNoted) return;
  const decision = opts.decisionFor(market, watch);
  if (!decision || !decision.side || decision.ask == null || !(decision.ask > 0) || decision.ask >= 1) {
    watch.skipNoted = true;
    push({ kind: "skip", id: nid("skip", opts.now), ts: opts.now, ticker: market.ticker, reason: "No forecast side or no live ask. Nothing was paper-filled." });
    return;
  }
  const side = decision.side;
  const limit = decision.limit != null && decision.limit > 0 && decision.limit < 1 ? decision.limit : decision.ask;
  push(limitOrder({
    now: opts.now,
    market,
    side,
    limit,
    count: decision.count,
    direction: side === "yes" ? "UP" : "DOWN",
    strike: watch.strike ?? market.strike ?? 0,
    bid: decision.bid,
    ask: decision.ask,
    path: decision.path,
    frames: decision.frames,
    conflicts: decision.conflicts,
    projection: decision.projection,
    forecast: decision.forecast,
    safety: decision.safety,
    lockCall: watch.revisedCall ?? watch.lockedCall,
    stop: decision.stop ?? null,
  }));
}

function reversePosition(rows: PaperRow[], push: (row: PaperRow) => void, market: MarketSnap, next: Direction, now: number) {
  const open = openPositions(rows)[market.ticker];
  if (open) {
    const bid = open.side === "yes" ? market.yesBid : market.noBid;
    const exit = bid > 0 ? bid : 0;
    const exitFee = takerFeeDollars(exit, open.count);
    push({
      kind: "exit",
      id: nid("exit", now),
      ts: now,
      ticker: market.ticker,
      entryId: open.entryId,
      exit,
      fees: exitFee,
      pnl: exitPnl({ count: open.count, entry: open.entry, entryFee: open.fee, exit, exitFee }),
      reason: "minute10",
    });
  }
  if (next !== "UP" && next !== "DOWN") return;
  const side = next === "UP" ? "yes" : "no";
  const ask = side === "yes" ? market.yesAsk : market.noAsk;
  if (!(ask > 0) || ask >= 1) return;
  const count = open?.count ?? 1;
  push(limitOrder({
    now,
    market,
    side,
    limit: ask,
    count,
    direction: next,
    strike: market.strike ?? 0,
    bid: side === "yes" ? market.yesBid : market.noBid,
    ask,
    path: "aligned",
    frames: [],
    projection: null,
    forecast: null,
    safety: "none",
    lockCall: next,
    stop: null,
  }));
}

function settleIfFinal(rows: PaperRow[], push: (row: PaperRow) => void, market: MarketSnap, now: number) {
  const status = market.status.toLowerCase();
  const result = (market.result || "").toLowerCase();
  if (!["finalized", "settled", "determined"].includes(status)) return;
  if (result !== "yes" && result !== "no") return;
  const open = openPositions(rows)[market.ticker];
  if (!open) return;
  const correct = open.side === result;
  push({
    kind: "settlement",
    id: nid("settle", now),
    ts: now,
    ticker: market.ticker,
    entryId: open.entryId,
    result,
    settlementPrice: correct ? 1 : 0,
    fees: 0,
    pnl: settlementPnl({ side: open.side, count: open.count, entry: open.entry, entryFee: open.fee, result }),
    correct,
    expirationValue: market.expirationValue,
  });
}

export function stepWatch(existing: Watch | null, market: MarketSnap, spot: SpotTick | null, now: number): { watch: Watch; event: "awaiting" | "locked" | "missed" | "revised" | "revision_refused" | "unchanged"; reason: string; flippedTo?: Direction } {
  const open = Date.parse(market.openTime || "");
  const id = windowId(market.ticker, market.closeTime);
  const base = (phase: Watch["phase"], extra: Partial<Watch> = {}, reason = ""): { watch: Watch; event: "missed"; reason: string } => ({
    watch: {
      windowId: id,
      ticker: market.ticker,
      openTime: market.openTime || "",
      closeTime: market.closeTime,
      phase,
      lockedCall: null,
      strike: market.strike,
      lockedAt: now,
      startPx: spot?.price ?? 0,
      ...extra,
    },
    event: "missed",
    reason,
  });
  if (!Number.isFinite(open)) return { watch: existing ?? base("missed").watch, event: "unchanged", reason: "" };
  const deadline = open + CALL_DEADLINE_MS;
  if (existing?.phase === "missed") return { watch: existing, event: "unchanged", reason: "" };
  if (existing?.phase === "locked" && existing.lockedCall) {
    return reviseIfDue(existing, market, spot, now);
  }
  if (now >= deadline) {
    if (!existing || existing.phase === "awaiting") {
      return base("missed", {}, existing ? "MISSED: no call committed by open+5:00" : "MISSED: no call committed by open+5:00");
    }
  }
  const strike = market.strike != null && market.strike > 0 ? market.strike : null;
  if (strike == null) {
    if (!existing) {
      return {
        watch: { windowId: id, ticker: market.ticker, openTime: market.openTime || "", closeTime: market.closeTime, phase: "awaiting", lockedCall: null, strike: null, lockedAt: now, startPx: 0 },
        event: "awaiting",
        reason: "No official floor_strike yet",
      };
    }
    return { watch: existing, event: "unchanged", reason: "" };
  }
  if (existing?.phase === "awaiting") {
    if (!isFreshSpotTick(spot, now)) return { watch: existing, event: "unchanged", reason: "" };
    const call = callVsStrike(spot.price, strike);
    return {
      watch: { ...existing, phase: "locked", lockedCall: call, strike, startPx: spot.price, lockedAt: now },
      event: "locked",
      reason: "Locked on the official floor_strike",
    };
  }
  if (!existing) {
    return base("missed", { strike }, "MISSED: the desk was not running when this window's strike was posted");
  }
  return { watch: existing, event: "unchanged", reason: "" };
}

function reviseIfDue(existing: Watch, market: MarketSnap, spot: SpotTick | null, now: number): { watch: Watch; event: "revised" | "revision_refused" | "unchanged"; reason: string; flippedTo?: Direction } {
  const tick = tenMinuteTick(existing.openTime);
  const close = Date.parse(existing.closeTime);
  if (!tick || !Number.isFinite(close) || now >= close || now < tick.start || now >= tick.end) {
    return { watch: existing, event: "unchanged", reason: "" };
  }
  if (!isFreshSpotTick(spot, now) || market.strike == null) return { watch: existing, event: "unchanged", reason: "" };
  const next = callVsStrike(spot.price, market.strike);
  const effective = existing.revisedCall ?? existing.lockedCall;
  if (next === effective || existing.lockedCall == null) return { watch: existing, event: "unchanged", reason: "" };
  if (existing.revision || existing.revisionRefusal) {
    return {
      watch: { ...existing, revisionRefusal: { at: now, attempted: next, reason: "second change" } },
      event: "revision_refused",
      reason: "A second change is refused",
    };
  }
  return {
    watch: {
      ...existing,
      revisedCall: next,
      strike: market.strike,
      revision: { at: now, from: existing.lockedCall, to: next, reason: "spot vs official strike at the ten-minute mark" },
    },
    event: "revised",
    reason: "One minute-10 change applied",
    flippedTo: next,
  };
}

export type PaperStats = {
  wins: number;
  losses: number;
  settled: number;
  missed: number;
  winRate: number | null;
  totalPnl: number;
  perDay: { date: string; pnl: number }[];
  equity: { t: number; equity: number }[];
  currentStreak: { kind: "win" | "loss" | "none"; length: number };
  longestWinStreak: number;
  longestLossStreak: number;
  byAlignment: { key: string; n: number; wins: number; pnl: number }[];
  byHour: { hour: number; n: number; wins: number; pnl: number }[];
  calibration: { bucket: string; n: number; hitRate: number | null; avgProb: number | null }[];
  open: OpenPaper[];
};

export function computeStats(rows: PaperRow[]): PaperStats {
  const settled = rows.filter((row): row is PaperSettlement => row.kind === "settlement");
  const pnlRows = rows.filter((row): row is PaperExit | PaperSettlement => row.kind === "exit" || row.kind === "settlement");
  const wins = settled.filter((row) => row.correct).length;
  const losses = settled.filter((row) => !row.correct).length;
  let equity = 0;
  const curve = pnlRows.map((row) => {
    equity += row.pnl;
    return { t: row.ts, equity };
  });
  const perDayMap = new Map<string, number>();
  for (const row of pnlRows) {
    const key = etDateKey(new Date(row.ts));
    perDayMap.set(key, (perDayMap.get(key) ?? 0) + row.pnl);
  }
  let current = { kind: "none" as "win" | "loss" | "none", length: 0 };
  let longestWin = 0;
  let longestLoss = 0;
  let runKind: "win" | "loss" | null = null;
  let run = 0;
  for (const row of settled) {
    const kind = row.correct ? "win" : "loss";
    if (kind === runKind) run += 1;
    else {
      runKind = kind;
      run = 1;
    }
    if (kind === "win") longestWin = Math.max(longestWin, run);
    else longestLoss = Math.max(longestLoss, run);
    current = { kind, length: run };
  }
  const align = new Map<string, { n: number; wins: number; pnl: number }>();
  const hours = new Map<number, { n: number; wins: number; pnl: number }>();
  const buckets = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, n: 0, hits: 0, prob: 0 }));
  for (const row of settled) {
    const entry = rows.find((item): item is PaperEntry => item.kind === "entry" && item.id === row.entryId);
    const frame = entry?.frames.find((item) => item.id === "6M");
    const key = `${entry?.path ?? "unknown"}|6M:${frame?.direction ?? "unknown"}`;
    const slot = align.get(key) ?? { n: 0, wins: 0, pnl: 0 };
    slot.n += 1;
    slot.wins += row.correct ? 1 : 0;
    slot.pnl += row.pnl;
    align.set(key, slot);
    const hour = zonedParts(new Date(row.ts)).hour;
    const hourSlot = hours.get(hour) ?? { n: 0, wins: 0, pnl: 0 };
    hourSlot.n += 1;
    hourSlot.wins += row.correct ? 1 : 0;
    hourSlot.pnl += row.pnl;
    hours.set(hour, hourSlot);
    const forecast = entry?.forecast as { probabilityAbove?: number } | null;
    const pAbove = forecast?.probabilityAbove;
    if (typeof pAbove === "number" && entry) {
      const prob = entry.side === "yes" ? pAbove : 1 - pAbove;
      const index = Math.min(9, Math.max(0, Math.floor(prob * 10)));
      buckets[index].n += 1;
      buckets[index].hits += row.correct ? 1 : 0;
      buckets[index].prob += prob;
    }
  }
  return {
    wins,
    losses,
    settled: settled.length,
    missed: rows.filter((row) => row.kind === "missed").length,
    winRate: settled.length ? wins / settled.length : null,
    totalPnl: pnlRows.reduce((sum, row) => sum + row.pnl, 0),
    perDay: [...perDayMap.entries()].map(([date, pnl]) => ({ date, pnl })),
    equity: curve,
    currentStreak: current.length ? current : { kind: "none", length: 0 },
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    byAlignment: [...align.entries()].map(([key, value]) => ({ key, ...value })),
    byHour: [...hours.entries()].map(([hour, value]) => ({ hour, ...value })).sort((a, b) => a.hour - b.hour),
    calibration: buckets.map((bucket) => ({
      bucket: `${bucket.lo.toFixed(1)}-${(bucket.lo + 0.1).toFixed(1)}`,
      n: bucket.n,
      hitRate: bucket.n ? bucket.hits / bucket.n : null,
      avgProb: bucket.n ? bucket.prob / bucket.n : null,
    })),
    open: Object.values(openPositions(rows)),
  };
}

export function rowsToCsv(rows: PaperRow[]): string {
  const header = ["kind", "ts", "ticker", "direction", "strike", "entry", "contracts", "fees", "pnl", "correct", "path", "proposalId"];
  const lines = [header.join(",")];
  for (const row of rows) {
    const cells = [
      row.kind,
      String(row.ts),
      "ticker" in row ? row.ticker : "",
      row.kind === "entry" ? row.direction : "",
      row.kind === "entry" ? String(row.strike) : "",
      row.kind === "entry" ? String(row.entry) : "",
      row.kind === "entry" ? String(row.contracts) : "",
      "fees" in row ? String(row.fees) : "",
      "pnl" in row ? String(row.pnl) : "",
      row.kind === "settlement" ? String(row.correct) : "",
      row.kind === "entry" ? row.path : "",
      row.kind === "entry" ? row.proposalId : "",
    ];
    lines.push(cells.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","));
  }
  return lines.join("\n");
}

export { DESK_POLL_MS };

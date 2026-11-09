/**
 * 24/7 paper book. It uses the desk's strike-post, minute-5 MISSED, and minute-10
 * rules (imported, not rewritten) and a separate paper ledger.
 *
 * Minute-10 rule: inside the one allowed tick, if callVsStrike flips the effective
 * call, the open paper position is closed at the held side's bid (taker fee) and,
 * when the new call is UP or DOWN, one replacement is opened at that side's ask.
 * AT STRIKE closes flat. A second change is refused and the position is left as it is.
 * The safety banner is recorded and never closes a position.
 *
 * ISOLATION: this module does not sign requests and does not import the live executor.
 */

import { callVsStrike } from "./engine";
import { CALL_DEADLINE_MS, DESK_POLL_MS, isFreshSpotTick, tenMinuteTick } from "./desk";
import { exitPnl, settlementPnl, takerFeeDollars } from "./kalshi-fees";
import { etDateKey, zonedParts } from "./et-time";
import { windowId } from "./signal-lock";
import type { Direction, SpotTick } from "./types";

export const GAP_MS = 20 * 60 * 1000;

export type PaperDirection = "UP" | "DOWN";

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
  frames: { id: string; direction: string | null; stale: boolean }[];
  projection: unknown;
  forecast: unknown;
  safety: "none" | "watch" | "danger";
  lockCall: Direction | null;
  proposalId: string;
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
  reason: "minute10";
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
};

export type PaperMiss = { kind: "missed"; id: string; ts: number; ticker: string; openTime: string; closeTime: string; reason: string };
export type PaperGap = { kind: "gap"; id: string; ts: number; from: number; to: number; reason: string };
export type PaperSkip = { kind: "skip"; id: string; ts: number; ticker: string; reason: string };
export type PaperRefusal = { kind: "refusal"; id: string; ts: number; ticker: string; reason: string };

export type PaperRow = PaperEntry | PaperExit | PaperSettlement | PaperMiss | PaperGap | PaperSkip | PaperRefusal;

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
};

export type OpenPaper = {
  ticker: string;
  entryId: string;
  side: "yes" | "no";
  count: number;
  entry: number;
  fee: number;
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
      map[row.ticker] = { ticker: row.ticker, entryId: row.id, side: row.side, count: row.contracts, entry: row.entry, fee: row.fees };
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
    if ((stepped.event === "locked" || stepped.event === "unchanged") && stepped.watch.phase === "locked" && !openPositions(rows)[market.ticker]) {
      maybeEnter(rows, push, market, stepped.watch, opts);
    }
  }
  return { watches, rows: created, lastPollAt: opts.now };
}

function maybeEnter(rows: PaperRow[], push: (row: PaperRow) => void, market: MarketSnap, watch: Watch, opts: { now: number; decisionFor: (market: MarketSnap, watch: Watch) => PaperDecision | null }) {
  if (openPositions(rows)[market.ticker] || watch.skipNoted) return;
  const decision = opts.decisionFor(market, watch);
  if (!decision || !decision.side || decision.ask == null || !(decision.ask > 0) || decision.ask >= 1) {
    watch.skipNoted = true;
    push({ kind: "skip", id: nid("skip", opts.now), ts: opts.now, ticker: market.ticker, reason: "No forecast side or no live ask. Nothing was paper-filled." });
    return;
  }
  const fees = takerFeeDollars(decision.ask, decision.count);
  const side = decision.side;
  push({
    kind: "entry",
    id: nid("entry", opts.now),
    ts: opts.now,
    ticker: market.ticker,
    openTime: market.openTime || "",
    closeTime: market.closeTime,
    direction: side === "yes" ? "UP" : "DOWN",
    side,
    strike: watch.strike ?? market.strike ?? 0,
    entry: decision.ask,
    bid: decision.bid,
    ask: decision.ask,
    spread: decision.bid == null ? null : decision.ask - decision.bid,
    contracts: decision.count,
    fees,
    path: decision.path,
    frames: decision.frames,
    projection: decision.projection,
    forecast: decision.forecast,
    safety: decision.safety,
    lockCall: watch.revisedCall ?? watch.lockedCall,
    proposalId: `paper_${nid("p", opts.now)}`,
  });
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
  const fees = takerFeeDollars(ask, count);
  push({
    kind: "entry",
    id: nid("entry", now),
    ts: now,
    ticker: market.ticker,
    openTime: market.openTime || "",
    closeTime: market.closeTime,
    direction: next,
    side,
    strike: market.strike ?? 0,
    entry: ask,
    bid: side === "yes" ? market.yesBid : market.noBid,
    ask,
    spread: (side === "yes" ? market.yesAsk - market.yesBid : market.noAsk - market.noBid),
    contracts: count,
    fees,
    path: "aligned",
    frames: [],
    projection: null,
    forecast: null,
    safety: "none",
    lockCall: next,
    proposalId: `paper_${nid("p", now)}`,
  });
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

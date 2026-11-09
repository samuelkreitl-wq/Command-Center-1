import { randomUUID } from "node:crypto";
import { readConfig, type DeskConfig } from "./config";
import type { DeskStore } from "./store";
import { assessExecute, hashOrder, isPaperProposalId, overCap, type OrderIntent, type Proposal } from "../money-os-desk/src/lib/order-gate";
import { describeStop, evaluateLimit, evaluateStop, normalizeStop, quoteIsStale, type StopSpec } from "../money-os-desk/src/lib/risk";
import { adjustForecast, conflictPatterns, learningStats } from "../money-os-desk/src/lib/learning";
import { missingRecordedRows } from "../money-os-desk/src/lib/recorded-trade";
import { cancelLimitOrder, placeLimitOrder, readExposure } from "./live-executor";
import { parseHorizonQuestion, parseUtterance } from "../money-os-desk/src/lib/spoken-parse";
import { resolveSpokenWindow, type ListedMarket } from "../money-os-desk/src/lib/window-resolve";
import { forecastToClose, scenarioIsStale, shortHorizonScenario, shouldRefresh, type ShortScenario } from "../money-os-desk/src/lib/forecast";
import { evaluateSafety, readSafetyThresholds } from "../money-os-desk/src/lib/safety-net";
import { evaluateTimeframes, type FrameSnapshot } from "../money-os-desk/src/lib/timeframe";
import { findCrossings, projectForward, projectionDrift, roundLevels, HORIZON_STEPS, type TfId } from "../money-os-desk/src/lib/projection";
import { TF_INTERVAL_MS } from "../money-os-desk/src/lib/timeframe";
import { runPaperOnce } from "./paper-runner";
import { fetchCloses, fetchKrakenLast, fetchMarkets } from "./public-data";
import type { PaperRow, Watch } from "../money-os-desk/src/lib/paper-book";
import { computeStats, rowsToCsv } from "../money-os-desk/src/lib/paper-book";

type LedgerPos = {
  ticker: string;
  side: "yes" | "no";
  count: number;
  price: number;
  status: "pending" | "open" | "resting" | "closed";
  clientOrderId: string;
  stop?: StopSpec | null;
  stopFired?: boolean;
  stopAuthorized?: boolean;
  stopSuppressed?: boolean;
  expiresAt?: number;
  orderId?: string;
};

type BookQuote = {
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  ts: number | null;
};

type TrackedOrder = {
  id: string;
  proposalId: string;
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  limit: number;
  count: number;
  status: "resting" | "filled" | "cancelled" | "expired";
  createdAt: number;
  expiresAt: number;
  clientOrderId: string;
  exchangeOrderId?: string;
  fillPrice?: number | null;
  filledAt?: number;
  stop: StopSpec | null;
  stopAuthorized: boolean;
  role: "entry" | "stop";
};

export type DeskRuntime = ReturnType<typeof createRuntime>;

export function createRuntime(deps: {
  store: DeskStore;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  placeOrder?: (order: OrderIntent) => Promise<{ orderId: string }>;
  fetchQuote?: (ticker: string, side: "yes" | "no") => Promise<number | null>;
  fetchBook?: (ticker: string) => Promise<BookQuote | null>;
  fetchMarkets?: () => Promise<ListedMarket[]>;
  fetchExposure?: (ticker: string) => Promise<{ blocked: boolean; side?: "yes" | "no"; count?: number; price?: number }>;
  cancelOrder?: (orderId: string) => Promise<void>;
}) {
  const env = deps.env ?? process.env;
  const config = readConfig(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const proposals = new Map<string, Proposal>();
  const locks = new Map<string, Promise<unknown>>();
  const startedAt = now();
  let lastHeartbeat = now();
  let lastPollAt: number | null = null;
  let feed: "LIVE" | "STALE" = "STALE";
  let traderRunning = false;
  let watches: Record<string, Watch> = {};
  let frameCache: Partial<Record<TfId, { computedAt: number; direction: "UPHILL" | "DOWNHILL" | "FLAT"; fittedLogReturn: number; slopePerBar: number; points: number; projection: unknown }>> = {};
  let scenario: ShortScenario | null = null;
  let seeding: Promise<void> | null = null;

  function ensureRecorded() {
    if (!seeding) {
      seeding = (async () => {
        const rows = (await deps.store.paperRows()) as PaperRow[];
        for (const row of missingRecordedRows(rows)) await deps.store.appendPaper(row);
      })().catch((error) => {
        seeding = null;
        throw error;
      });
    }
    return seeding;
  }

  const withLock = <T>(ticker: string, fn: () => Promise<T>) => {
    const prev = locks.get(ticker) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(ticker, run.then(() => undefined, () => undefined));
    return run;
  };

  async function journal(kind: string, payload: Record<string, unknown>) {
    await deps.store.appendJournal({ kind, ts: now(), ...payload });
  }

  async function ledger(): Promise<Record<string, LedgerPos>> {
    const raw = await deps.store.getKv("live-ledger");
    return raw ? JSON.parse(raw) as Record<string, LedgerPos> : {};
  }
  async function saveLedger(rows: Record<string, LedgerPos>) {
    await deps.store.setKv("live-ledger", JSON.stringify(rows));
  }
  async function loadOrders(): Promise<TrackedOrder[]> {
    const raw = await deps.store.getKv("live-orders");
    return raw ? JSON.parse(raw) as TrackedOrder[] : [];
  }
  async function saveOrders(rows: TrackedOrder[]) {
    await deps.store.setKv("live-orders", JSON.stringify(rows));
  }

  async function mode(): Promise<DeskConfig["mode"]> {
    const saved = await deps.store.getKv("desk-mode");
    if (saved === "paper" || saved === "live" || saved === "both") return saved;
    return config.mode;
  }

  async function positionBlock(ticker: string) {
    const row = (await ledger())[ticker];
    if (row && (row.status === "pending" || row.status === "open" || row.status === "resting" || row.status === "closed")) return row;
    const exposure = deps.fetchExposure
      ? await deps.fetchExposure(ticker)
      : await readExposure(ticker, env, fetchImpl).catch(() => ({ blocked: true as const, side: undefined, count: undefined, price: undefined }));
    if (exposure.blocked && exposure.side) return { ticker, side: exposure.side, count: exposure.count ?? 0, price: exposure.price ?? 0, status: "open" as const, clientOrderId: "" };
    return null;
  }

  function openProposal(ticker: string) {
    for (const proposal of proposals.values()) {
      if (proposal.order.ticker === ticker && !proposal.cancelled && !proposal.used && proposal.expiresAt > now()) return proposal;
    }
    return null;
  }

  function holdProposal(order: OrderIntent, meta: Record<string, unknown> = {}) {
    if (overCap(order, config.maxContracts, config.maxCost)) {
      return { ok: false as const, reason: "over_cap", message: "The order is over the contract or cost cap." };
    }
    if (openProposal(order.ticker)) {
      return { ok: false as const, reason: "duplicate", message: `A proposal is already open for ${order.ticker}` };
    }
    const proposal: Proposal = {
      id: randomUUID(),
      order,
      orderHash: hashOrder(order),
      expiresAt: now() + config.ttlMs,
      used: false,
      cancelled: false,
      confirmed: false,
      meta,
    };
    proposals.set(proposal.id, proposal);
    return { ok: true as const, proposal };
  }

  async function loadMarkets() {
    if (deps.fetchMarkets) return deps.fetchMarkets();
    const [open, unopened, settled] = await Promise.all([
      fetchMarkets(fetchImpl, env, "KXBTC15M", "open"),
      fetchMarkets(fetchImpl, env, "KXBTC15M", "unopened").catch(() => []),
      fetchMarkets(fetchImpl, env, "KXBTC15M", "settled").catch(() => []),
    ]);
    return [...open, ...unopened, ...settled];
  }

  async function bookFor(ticker: string): Promise<BookQuote | null> {
    if (deps.fetchBook) return deps.fetchBook(ticker);
    if (deps.fetchQuote) return null;
    try {
      const markets = await loadMarkets();
      const market = markets.find((item) => item.ticker === ticker);
      if (!market) return null;
      return { yesBid: market.yesBid, yesAsk: market.yesAsk, noBid: market.noBid, noAsk: market.noAsk, ts: now() };
    } catch {
      return null;
    }
  }

  async function quote(ticker: string, side: "yes" | "no") {
    if (deps.fetchQuote) return deps.fetchQuote(ticker, side);
    const markets = await loadMarkets();
    const market = markets.find((item) => item.ticker === ticker);
    if (!market) return null;
    const ask = side === "yes" ? market.yesAsk : market.noAsk;
    return ask > 0 && ask < 1 ? ask : null;
  }

  async function propose(utterance: string, count?: number, extra: { limitPrice?: number | null; stopPercent?: number | null; stopDollars?: number | null } = {}) {
    const horizon = parseHorizonQuestion(utterance);
    if (horizon) {
      const current = await horizonView(false);
      return { ok: true, kind: "horizon" as const, horizon, scenario: current.scenario, stale: current.stale, message: current.scenario ? "SCENARIO" : current.message };
    }
    const parsed = parseUtterance(utterance);
    if (!parsed.time) return refuse("bad_time", "Say the window close, for example 1:15.");
    if (parsed.errors.length) return refuse("bad_parse", parsed.errors[0]);
    let markets: ListedMarket[];
    try {
      markets = await loadMarkets();
    } catch (error) {
      return refuse("feed", error instanceof Error ? error.message : "Market data is unavailable.");
    }
    const resolved = resolveSpokenWindow(parsed.time, markets, now());
    if (!resolved.ok) return refuse(resolved.reason, resolved.message);
    const market = resolved.market;
    if (market.floorStrike == null) {
      return { ok: false, kind: "refused" as const, reason: "no_strike", message: "no strike yet", market: publicMarket(market) };
    }
    const held = await positionBlock(market.ticker);
    if (held) {
      const message = `Position already held on ${market.ticker}`;
      await journal("refusal", { message, ticker: market.ticker, position: held });
      return { ok: false, kind: "refused" as const, reason: "position_held", message, position: { ticker: market.ticker, side: held.side, count: held.count, price: held.price }, market: publicMarket(market) };
    }
    if (openProposal(market.ticker)) return refuse("duplicate", `A proposal is already open for ${market.ticker}`);
    const spot = await fetchKrakenLast(fetchImpl, env).catch(() => null);
    const minutes = await fetchCloses(fetchImpl, env, 1).catch(() => []);
    const context = await contextView();
    const sigma = 0.01;
    const drift = projectionDrift({ sigma, frames: context.frames.map((frame) => ({ id: frame.id, direction: frame.direction })) });
    const forecast = forecastToClose({
      spot: spot ?? 0,
      minuteCloses: minutes,
      minutesRemaining: Math.max(0, (Date.parse(market.closeTime) - now()) / 60_000),
      strike: market.floorStrike,
      now: now(),
      longBias: context.longBias,
      projectionSigma: sigma > 0 ? drift.applied / sigma : 0,
      reversalHalve: !!context.deep?.reversal,
    });
    if (!forecast.ok || forecast.probabilityAbove == null) return refuse("no_forecast", forecast.ok ? "The scenario has no side." : forecast.reason);
    await ensureRecorded();
    const history = (await deps.store.paperRows()) as PaperRow[];
    const tape = context.frames.map((frame) => ({ id: frame.id, direction: frame.direction, stale: frame.stale, known: frame.direction != null && !frame.stale }));
    const adjusted = adjustForecast({ probabilityAbove: forecast.probabilityAbove, frames: tape, history });
    const favored = adjusted.adjusted > 0.5 ? "yes" : adjusted.adjusted < 0.5 ? "no" : null;
    const side = parsed.side ?? favored;
    if (!side) return refuse("no_side", "The scenario does not favor a side. Say up or down.");
    const ask = side === "yes" ? market.yesAsk : market.noAsk;
    if (!(ask > 0) || ask >= 1) return refuse("no_ask", "No live ask for that side.");
    const contracts = count ?? parsed.count ?? 1;
    let limitPrice = Math.round(ask * 100) / 100;
    if (extra.limitPrice != null) {
      if (!(extra.limitPrice > 0) || extra.limitPrice >= 1) return refuse("bad_limit", "Limit price must be above 0 and below 1.");
      limitPrice = Math.round(extra.limitPrice * 10_000) / 10_000;
    }
    const stopParsed = resolveStop(extra, env);
    if (stopParsed === "bad") return refuse("bad_stop", "Stop percent must be above 0 and at most 1. Stop dollars must be above 0.");
    const intent: OrderIntent = { ticker: market.ticker, side, action: "buy", count: contracts, limitPrice, clientOrderId: randomUUID() };
    const heldProposal = holdProposal(intent, {
      forecast,
      adjusted,
      path: context.path,
      frames: tape,
      conflicts: conflictPatterns(tape),
      projection: drift,
      parsed,
      stop: stopParsed,
      referencePrice: ask,
      closeTime: market.closeTime,
    });
    if (!heldProposal.ok) return refuse(heldProposal.reason, heldProposal.message);
    await journal("proposal", { proposalId: heldProposal.proposal.id, ticker: market.ticker, order: intent, forecast, adjusted, projection: drift, path: context.path, stop: stopParsed });
    const edgeYes = adjusted.adjusted - market.yesAsk;
    const edgeNo = (1 - adjusted.adjusted) - market.noAsk;
    return {
      ok: true,
      kind: "order" as const,
      proposalId: heldProposal.proposal.id,
      orderHash: heldProposal.proposal.orderHash,
      expiresAt: heldProposal.proposal.expiresAt,
      order: { ...intent, maxCost: intent.count * intent.limitPrice },
      stop: stopParsed,
      stopSummary: describeStop(stopParsed),
      market: publicMarket(market),
      spot,
      parsed: { price: parsed.price, timeLabel: parsed.time.raw, side: parsed.side },
      forecast,
      adjusted,
      edge: { yes: edgeYes, no: edgeNo },
      timeframes: context.frames,
      path: context.path,
      deep: context.deep,
      projection: { contribution: drift, crossings: context.crossings, charts: context.charts },
      message: "Confirm to place this order.",
    };
  }

  async function execute(body: { proposalId?: string; orderHash?: string; confirm?: unknown }) {
    if (body.proposalId && isPaperProposalId(body.proposalId)) {
      await journal("refusal", { message: "Paper proposals are not sent to Kalshi.", proposalId: body.proposalId });
      return refuse("paper_proposal", "Paper proposals are not sent to Kalshi.");
    }
    const proposal = body.proposalId ? proposals.get(body.proposalId) ?? null : null;
    const ticker = proposal?.order.ticker ?? "";
    return withLock(ticker || "none", async () => {
      const current = body.proposalId ? proposals.get(body.proposalId) ?? null : null;
      const deskMode = await mode();
      const bookQuote = current ? await bookFor(current.order.ticker) : null;
      const freshAsk = bookQuote
        ? (current?.order.side === "yes" ? bookQuote.yesAsk : bookQuote.noAsk)
        : current ? await quote(current.order.ticker, current.order.side) : null;
      const freshBid = bookQuote ? (current?.order.side === "yes" ? bookQuote.yesBid : bookQuote.noBid) : null;
      const liveMode = deskMode === "live" || deskMode === "both";
      const held = current && liveMode ? await positionBlock(current.order.ticker) : null;
      const referencePrice = current && typeof current.meta.referencePrice === "number" ? current.meta.referencePrice : undefined;
      const gate = assessExecute({
        confirm: body.confirm,
        proposal: current,
        orderHash: body.orderHash ?? "",
        now: now(),
        tradingEnabled: config.tradingEnabled,
        freshAsk,
        freshBid,
        referencePrice,
        tolerance: config.tolerance,
        maxContracts: config.maxContracts,
        maxCost: config.maxCost,
        positionBlocked: !!held,
        modeAllowsLive: liveMode,
      });
      if (!gate.ok || !current) {
        const failure = gate.ok ? refuse("missing", "Unknown proposal.") : gate;
        await journal("refusal", { message: failure.message, reason: failure.reason, proposalId: body.proposalId });
        return failure;
      }
      const hasKey = Boolean(env.KALSHI_API_KEY_ID && (env.KALSHI_PRIVATE_KEY || env.KALSHI_PRIVATE_KEY_PATH));
      if (!deps.placeOrder && !hasKey) {
        await journal("refusal", { message: "Kalshi credentials are not configured.", proposalId: current.id });
        return refuse("missing_keys", "Kalshi credentials are not configured.");
      }
      current.used = true;
      current.confirmed = true;
      const stop = normalizeStop(current.meta.stop as StopSpec | null);
      const closeMs = typeof current.meta.closeTime === "string" ? Date.parse(current.meta.closeTime) : Number.POSITIVE_INFINITY;
      const book = await ledger();
      book[current.order.ticker] = { ticker: current.order.ticker, side: current.order.side, count: current.order.count, price: current.order.limitPrice, status: "pending", clientOrderId: current.order.clientOrderId, stop, stopFired: false, stopAuthorized: true, expiresAt: Number.isFinite(closeMs) ? closeMs : undefined };
      await saveLedger(book);
      await journal("confirm", { proposalId: current.id, order: current.order, stop, stopSummary: describeStop(stop) });
      try {
        const placed = deps.placeOrder ? await deps.placeOrder(current.order) : await placeLimitOrder(current.order, env, fetchImpl).then((result) => ({ orderId: result.orderId }));
        const fill = evaluateLimit(
          { action: current.order.action, limit: current.order.limitPrice, cancelled: false, expiresAt: closeMs },
          { bid: freshBid, ask: freshAsk },
          now(),
        );
        const resting = fill.status !== "filled";
        const orders = await loadOrders();
        orders.push({
          id: randomUUID(),
          proposalId: current.id,
          ticker: current.order.ticker,
          action: current.order.action,
          side: current.order.side,
          limit: current.order.limitPrice,
          count: current.order.count,
          status: resting ? "resting" : "filled",
          createdAt: now(),
          expiresAt: closeMs,
          clientOrderId: current.order.clientOrderId,
          exchangeOrderId: placed.orderId,
          fillPrice: fill.fillPrice,
          filledAt: resting ? undefined : now(),
          stop,
          stopAuthorized: true,
          role: "entry",
        });
        await saveOrders(orders);
        book[current.order.ticker] = {
          ...book[current.order.ticker],
          status: resting ? "resting" : "open",
          price: fill.fillPrice ?? current.order.limitPrice,
          orderId: placed.orderId,
          stop,
          stopAuthorized: true,
          stopFired: false,
        };
        await saveLedger(book);
        await journal("order", { proposalId: current.id, orderId: placed.orderId, ticker: current.order.ticker, status: resting ? "resting" : "filled", stop });
        return { ok: true, kind: "executed" as const, orderId: placed.orderId, ticker: current.order.ticker, status: resting ? "resting" as const : "filled" as const, stop, stopSummary: describeStop(stop) };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status < 500) {
          delete book[current.order.ticker];
          await saveLedger(book);
        }
        const message = error instanceof Error ? error.message : "Order failed.";
        await journal("order", { proposalId: current.id, error: message });
        return refuse("exchange", message);
      }
    });
  }

  function cancel(proposalId: string) {
    const proposal = proposals.get(proposalId);
    if (!proposal || proposal.used) return refuse("missing", "Nothing to cancel.");
    proposal.cancelled = true;
    return { ok: true, kind: "cancelled" as const };
  }

  async function contextView() {
    let spot: number | null = null;
    let frames: FrameSnapshot[] = [];
    let path: "aligned" | "conflict" = "aligned";
    let longBias: "UPHILL" | "DOWNHILL" | "FLAT" = "FLAT";
    let deep = null as { reversal?: boolean; notes?: string[] } | null;
    let minuteCloses: number[] = [];
    try {
      const bundle = await evaluateTimeframes({
        now: now(),
        cache: frameCache,
        load: async (id) => {
          const interval = id === "M" ? 1 : id === "1H" ? 5 : id === "1D" ? 60 : 1440;
          const closes = await fetchCloses(fetchImpl, env, interval);
          if (id === "M") minuteCloses = closes;
          return { closes };
        },
      });
      frameCache = bundle.cache;
      frames = bundle.frames;
      path = bundle.path;
      longBias = bundle.longBias;
      deep = bundle.deep;
      minuteCloses = bundle.minuteCloses.length ? bundle.minuteCloses : minuteCloses;
      spot = await fetchKrakenLast(fetchImpl, env);
    } catch {
      frames = frames.map((frame) => ({ ...frame, stale: true }));
    }
    const projected = minuteCloses.length > 3 ? projectForward(minuteCloses, TF_INTERVAL_MS.M, 15, now()) : null;
    const crossings = projected && spot ? findCrossings(
      projected.points.map((point) => ({ t: point.t, price: point.price, low: point.low90, high: point.high90 })),
      roundLevels(spot, Math.max(1000, Math.abs(projected.points.at(-1)!.high90 - spot))),
    ) : [];
    return { frames, path, longBias, deep, spot, minuteCloses, charts: projected ? [projected] : [], crossings };
  }

  async function horizonView(force: boolean) {
    const saved = await deps.store.getKv("short-horizon");
    const cached = saved ? JSON.parse(saved) as ShortScenario : scenario;
    if (cached && !shouldRefresh(cached.computedAt, now(), config.horizonRefreshMs, force)) {
      scenario = cached;
      return { scenario: cached, stale: scenarioIsStale(cached.computedAt, now(), config.horizonRefreshMs * 2), message: "" };
    }
    try {
      const [spot, daily] = await Promise.all([fetchKrakenLast(fetchImpl, env), fetchCloses(fetchImpl, env, 1440)]);
      const context = await contextView();
      const drift = projectionDrift({ sigma: 0.01, frames: context.frames.map((frame) => ({ id: frame.id, direction: frame.direction })) });
      const built = shortHorizonScenario({ spot: spot ?? 0, dailyCloses: daily, now: now(), longBias: context.longBias, projectionSigma: drift.applied / 0.01 });
      if (!built.ok) return { scenario: cached, stale: true, message: built.reason };
      scenario = built;
      await deps.store.setKv("short-horizon", JSON.stringify(built));
      return { scenario: built, stale: false, message: "" };
    } catch (error) {
      return { scenario: cached, stale: true, message: error instanceof Error ? error.message : "Scenario unavailable." };
    }
  }

  async function safetyStatus() {
    const view = await horizonView(false);
    const context = await contextView();
    const headline = view.scenario?.horizons["3d"];
    const evaluated = evaluateSafety({
      pointReturn: headline?.pointReturn ?? null,
      lower90Return: headline?.lower90Return ?? null,
      pDrop10: headline?.pDrop10 ?? null,
      longBias: context.longBias,
      shortTape: context.frames ? (await import("../money-os-desk/src/lib/timeframe")).shortTape(context.frames) : null,
      acceleration: context.minuteCloses ? (await import("../money-os-desk/src/lib/timeframe")).tapeAcceleration(context.minuteCloses) : null,
      thresholds: readSafetyThresholds(env),
    });
    const previous = await deps.store.getKv("safety-level");
    if (previous !== evaluated.level) {
      await deps.store.setKv("safety-level", evaluated.level);
      await deps.store.setKv("safety-since", String(now()));
      await journal(evaluated.level === "none" ? "safety-clear" : "safety", { level: evaluated.level, active: evaluated.active });
    }
    const since = await deps.store.getKv("safety-since");
    return {
      level: evaluated.level,
      stale: view.stale,
      computedAt: view.scenario?.computedAt ?? null,
      ageMs: view.scenario ? now() - view.scenario.computedAt : null,
      since: since ? Number(since) : null,
      spot: view.scenario?.spot ?? context.spot,
      triggers: evaluated.active,
      active: evaluated.active,
      thresholds: readSafetyThresholds(env),
      assumptions: view.scenario?.assumptions ?? [],
      headline,
      horizons: view.scenario?.horizons ?? null,
      note: "Read-only. This alert never sells or places an order.",
    };
  }

  async function cancelExchange(orderId: string) {
    if (deps.cancelOrder) return deps.cancelOrder(orderId);
    await cancelLimitOrder(orderId, env, fetchImpl);
  }

  async function riskTick() {
    lastHeartbeat = now();
    traderRunning = true;
    const deskMode = await mode();
    const liveMode = deskMode === "live" || deskMode === "both";
    const orders = await loadOrders();
    const book = await ledger();
    let ordersChanged = false;
    let bookChanged = false;
    for (const order of orders) {
      if (order.status !== "resting") continue;
      if (Number.isFinite(order.expiresAt) && now() >= order.expiresAt) {
        order.status = "expired";
        ordersChanged = true;
        const row = book[order.ticker];
        if (row && (row.status === "resting" || row.status === "pending")) {
          delete book[order.ticker];
          bookChanged = true;
        }
        if (order.exchangeOrderId && config.tradingEnabled && liveMode) {
          try {
            await cancelExchange(order.exchangeOrderId);
          } catch (error) {
            await journal("limit-expire", { ticker: order.ticker, time: now(), error: error instanceof Error ? error.message : "cancel failed" });
          }
        }
        await journal("limit-expire", { ticker: order.ticker, time: now(), limit: order.limit, orderId: order.exchangeOrderId ?? null });
        continue;
      }
      const quoteBook = await bookFor(order.ticker);
      if (!quoteBook || quoteIsStale(quoteBook.ts, now())) continue;
      const bid = order.side === "yes" ? quoteBook.yesBid : quoteBook.noBid;
      const ask = order.side === "yes" ? quoteBook.yesAsk : quoteBook.noAsk;
      const decision = evaluateLimit({ action: order.action, limit: order.limit, cancelled: false, expiresAt: order.expiresAt }, { bid, ask }, now());
      if (decision.status !== "filled" || decision.fillPrice == null) continue;
      order.status = "filled";
      order.fillPrice = decision.fillPrice;
      order.filledAt = now();
      ordersChanged = true;
      if (order.action === "buy") {
        book[order.ticker] = {
          ticker: order.ticker,
          side: order.side,
          count: order.count,
          price: decision.fillPrice,
          status: "open",
          clientOrderId: order.clientOrderId,
          stop: order.stop,
          stopFired: false,
          stopAuthorized: order.stopAuthorized,
          expiresAt: Number.isFinite(order.expiresAt) ? order.expiresAt : undefined,
          orderId: order.exchangeOrderId,
        };
        bookChanged = true;
      } else if (book[order.ticker]) {
        book[order.ticker] = { ...book[order.ticker], status: "closed", stopFired: true };
        bookChanged = true;
      }
      await journal("limit-fill", { ticker: order.ticker, price: decision.fillPrice, time: now(), action: order.action });
    }
    for (const pos of Object.values(book)) {
      if (pos.status !== "open" || !pos.stop || pos.stopFired || pos.stopAuthorized === false) continue;
      const quoteBook = await bookFor(pos.ticker);
      if (!quoteBook || quoteIsStale(quoteBook.ts, now())) continue;
      const mark = pos.side === "yes" ? quoteBook.yesBid : quoteBook.noBid;
      const decision = evaluateStop({
        entry: pos.price,
        count: pos.count,
        mark,
        stop: pos.stop,
        stale: false,
        alreadyFired: !!pos.stopFired,
      });
      if (!decision.fire || decision.price == null || !decision.reason) {
        if (pos.stopSuppressed) {
          pos.stopSuppressed = false;
          bookChanged = true;
        }
        continue;
      }
      if (!config.tradingEnabled || !liveMode) {
        if (!pos.stopSuppressed) {
          pos.stopSuppressed = true;
          bookChanged = true;
          await journal("stop", {
            reason: decision.reason,
            price: decision.price,
            time: now(),
            ticker: pos.ticker,
            sent: false,
            why: !config.tradingEnabled ? "trading_disabled" : "mode_paper",
          });
        }
        continue;
      }
      const sell: OrderIntent = {
        ticker: pos.ticker,
        side: pos.side,
        action: "sell",
        count: pos.count,
        limitPrice: decision.price,
        clientOrderId: randomUUID(),
      };
      try {
        const placed = deps.placeOrder
          ? await deps.placeOrder(sell)
          : await placeLimitOrder(sell, env, fetchImpl).then((result) => ({ orderId: result.orderId }));
        pos.stopFired = true;
        pos.status = "closed";
        bookChanged = true;
        orders.push({
          id: randomUUID(),
          proposalId: pos.orderId || pos.clientOrderId,
          ticker: pos.ticker,
          action: "sell",
          side: pos.side,
          limit: decision.price,
          count: pos.count,
          status: "filled",
          createdAt: now(),
          expiresAt: pos.expiresAt ?? now(),
          clientOrderId: sell.clientOrderId,
          exchangeOrderId: placed.orderId,
          fillPrice: decision.price,
          filledAt: now(),
          stop: null,
          stopAuthorized: true,
          role: "stop",
        });
        ordersChanged = true;
        await journal("stop", { reason: decision.reason, price: decision.price, time: now(), ticker: pos.ticker, sent: true, orderId: placed.orderId });
      } catch (error) {
        await journal("stop", { reason: decision.reason, price: decision.price, time: now(), ticker: pos.ticker, sent: false, error: error instanceof Error ? error.message : "exit failed" });
      }
    }
    if (ordersChanged) await saveOrders(orders);
    if (bookChanged) await saveLedger(book);
  }

  async function cancelResting(orderId: string) {
    const orders = await loadOrders();
    const order = orders.find((item) => item.id === orderId || item.exchangeOrderId === orderId || item.proposalId === orderId);
    if (!order || order.status !== "resting") return refuse("missing", "No resting limit to cancel.");
    order.status = "cancelled";
    if (order.exchangeOrderId && config.tradingEnabled) {
      const deskMode = await mode();
      if (deskMode === "live" || deskMode === "both") {
        try {
          await cancelExchange(order.exchangeOrderId);
        } catch (error) {
          await journal("cancel", { orderId, ticker: order.ticker, time: now(), error: error instanceof Error ? error.message : "cancel failed" });
        }
      }
    }
    const book = await ledger();
    const row = book[order.ticker];
    if (row && (row.status === "resting" || row.status === "pending")) delete book[order.ticker];
    await saveOrders(orders);
    await saveLedger(book);
    await journal("cancel", { orderId: order.id, ticker: order.ticker, time: now(), exchangeOrderId: order.exchangeOrderId ?? null });
    return { ok: true, kind: "cancelled" as const };
  }

  async function paperTick() {
    lastHeartbeat = now();
    traderRunning = true;
    await ensureRecorded();
    const deskMode = await mode();
    if (deskMode === "live") {
      feed = "STALE";
      return;
    }
    const prior = (await deps.store.paperRows()) as PaperRow[];
    const safety = await deps.store.getKv("safety-level");
    const result = await runPaperOnce({
      fetchImpl,
      env,
      now: now(),
      rows: prior,
      watches,
      lastPollAt,
      safety: safety === "watch" || safety === "danger" ? safety : "none",
    });
    watches = result.watches;
    lastPollAt = result.lastPollAt;
    feed = result.feed;
    lastHeartbeat = now();
    for (const row of result.rows) {
      await deps.store.appendPaper(row);
      if (row.kind === "exit" && row.reason === "stop") {
        await journal("stop", { reason: row.stopReason, price: row.exit, time: row.ts, ticker: row.ticker, sent: false, book: "paper" });
      }
    }
  }

  async function health() {
    const age = lastPollAt == null ? null : now() - lastPollAt;
    const deskMode = await mode();
    return {
      ok: true,
      uptimeSec: Math.max(0, Math.round((now() - startedAt) / 1000)),
      startedAt,
      lastHeartbeat,
      lastPollAt,
      feed: feed === "LIVE" && age != null && age < 45_000 ? "LIVE" : "STALE",
      mode: deskMode,
      traderRunning,
      tradingEnabled: config.tradingEnabled,
      kalshiEnv: config.kalshiEnv,
      liveArmed: deskMode !== "paper" && config.tradingEnabled,
    };
  }

  async function stats() {
    await ensureRecorded();
    return computeStats((await deps.store.paperRows()) as PaperRow[]);
  }

  async function trades() {
    await ensureRecorded();
    return (await deps.store.paperRows()) as PaperRow[];
  }

  async function learning() {
    await ensureRecorded();
    return learningStats((await deps.store.paperRows()) as PaperRow[]);
  }

  return {
    config, now, propose, execute, cancel, cancelResting, holdProposal, contextView, horizonView, safetyStatus, paperTick, riskTick, health, stats, trades, learning, mode,
    async setMode(next: string) {
      if (next !== "paper" && next !== "live" && next !== "both") return refuse("bad_mode", "Mode must be paper, live, or both.");
      await deps.store.setKv("desk-mode", next);
      config.mode = next;
      return { ok: true, mode: next, liveArmed: next !== "paper" && config.tradingEnabled };
    },
    async csv() { return rowsToCsv(await trades()); },
    markHeartbeat() { lastHeartbeat = now(); traderRunning = true; },
    async resetEphemeral() {
      proposals.clear();
      await deps.store.deleteKv("live-ledger");
      await deps.store.deleteKv("live-orders");
      await deps.store.setKv("desk-mode", config.mode);
    },
    chartsFor(closes: number[], id: TfId, lastTime: number) {
      return projectForward(closes, TF_INTERVAL_MS[id], HORIZON_STEPS[id], lastTime);
    },
    crossingsFor(path: { t: number; price: number; low: number; high: number }[], spot: number, strikes: { price: number; label: string; source: string }[]) {
      const span = Math.max(1000, ...path.map((point) => Math.abs(point.high - point.price)));
      return findCrossings(path.map((point) => ({ t: point.t, price: point.price, low: point.low, high: point.high })), [...strikes, ...roundLevels(spot, span)]);
    },
  };
}

function envStopNumber(value: string | undefined, hi: number): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= hi ? n : null;
}

function resolveStop(extra: { stopPercent?: number | null; stopDollars?: number | null }, env: Record<string, string | undefined>): StopSpec | null | "bad" {
  const percent = extra.stopPercent !== undefined ? extra.stopPercent : envStopNumber(env.STOP_LOSS_PERCENT, 1);
  const dollars = extra.stopDollars !== undefined ? extra.stopDollars : envStopNumber(env.STOP_LOSS_DOLLARS, 1_000_000);
  if (percent != null && (!(percent > 0) || percent > 1)) return "bad";
  if (dollars != null && (!(dollars > 0) || dollars > 1_000_000)) return "bad";
  return normalizeStop({ percent: percent ?? null, dollars: dollars ?? null });
}

function refuse(reason: string, message: string) {
  return { ok: false as const, kind: "refused" as const, reason, message };
}

function publicMarket(market: ListedMarket) {
  return {
    ticker: market.ticker,
    openTime: market.openTime,
    closeTime: market.closeTime,
    floorStrike: market.floorStrike,
    yesAsk: market.yesAsk,
    noAsk: market.noAsk,
    yesBid: market.yesBid,
    noBid: market.noBid,
    status: market.status,
    title: market.title,
  };
}

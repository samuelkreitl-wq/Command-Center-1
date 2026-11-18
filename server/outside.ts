/**
 * Read-only view of Kalshi activity that did not come from this Command Center.
 *
 * Orders this desk places always carry a client_order_id (see orders.ts). Orders with an
 * EMPTY client_order_id came from somewhere else: another API key (for example the key
 * named "momentum-bot-btc15"), the Kalshi app, or the Kalshi website. Kalshi does not say
 * which API key placed an order, so this module labels that activity "outside", not
 * "momentum", unless MOMENTUM_BOT_CLIENT_ORDER_PREFIX is set and an order carries it.
 *
 * Safety: every request here is a signed GET. There is no order, cancel, amend or transfer
 * path in this file, and readOnlyGet refuses any other method.
 */
import { keysConfigured, shardLabel, signedKalshi } from "./kalshi-private.js";
import { fetchMarket, type RawMarket } from "./kalshi-public.js";

type Env = Record<string, string | undefined>;
type Signed = (env: Env, method: string, pathWithQuery: string) => Promise<{ status: number; body: unknown }>;

export type RawOrder = {
  order_id: string;
  ticker: string;
  action?: string;
  side?: string;
  type?: string;
  status?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  initial_count_fp?: string;
  fill_count_fp?: string;
  remaining_count_fp?: string;
  exchange_index?: number;
  client_order_id?: string | null;
  created_time?: string;
};
export type RawFill = {
  fill_id?: string;
  order_id: string;
  ticker: string;
  action?: string;
  side?: string;
  count_fp?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  fee_cost?: string;
  is_taker?: boolean;
  exchange_index?: number;
  created_time?: string;
  ts?: number;
};
export type RawPosition = {
  ticker: string;
  position_fp?: string;
  market_exposure_dollars?: string;
  fees_paid_dollars?: string;
  realized_pnl_dollars?: string;
  exchange_index?: number;
};
export type RawSettlement = {
  ticker: string;
  market_result?: string;
  yes_count_fp?: string;
  no_count_fp?: string;
  yes_total_cost_dollars?: string;
  no_total_cost_dollars?: string;
  fee_cost?: string;
  settled_time?: string;
};
export type RawTransfer = {
  transfer_id?: string;
  client_transfer_id?: string | null;
  amount?: string;
  source_exchange_shard?: number;
  destination_exchange_shard?: number;
  status?: string;
  created_ts?: number;
};

export type Origin = "desk" | "outside" | "momentum-tag" | "mixed" | "unknown";

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Empty client_order_id means the order did not come from this desk. */
export function orderOrigin(order: Pick<RawOrder, "client_order_id">, momentumPrefix?: string): Exclude<Origin, "mixed" | "unknown"> {
  const id = (order.client_order_id ?? "").trim();
  if (momentumPrefix && id.startsWith(momentumPrefix)) return "momentum-tag";
  return id ? "desk" : "outside";
}

export function tickerOrigins(orders: RawOrder[], momentumPrefix?: string): Map<string, Origin> {
  const seen = new Map<string, Set<string>>();
  for (const order of orders) {
    const set = seen.get(order.ticker) ?? new Set<string>();
    set.add(orderOrigin(order, momentumPrefix));
    seen.set(order.ticker, set);
  }
  const out = new Map<string, Origin>();
  for (const [ticker, set] of seen) {
    if (set.size > 1) out.set(ticker, "mixed");
    else out.set(ticker, [...set][0] as Origin);
  }
  return out;
}

/**
 * Settled P&L under netting: matched YES/NO pairs redeem for $1, the leftover side pays $1
 * only if it won. Kalshi's `revenue` field reads 0 for netted tickers, so it is not used.
 */
export function settledPnl(s: RawSettlement): number {
  const yes = n(s.yes_count_fp);
  const no = n(s.no_count_fp);
  const paired = Math.min(yes, no);
  const winner = s.market_result === "yes" ? yes - paired : s.market_result === "no" ? no - paired : 0;
  const payout = paired + winner;
  return r2(payout - n(s.yes_total_cost_dollars) - n(s.no_total_cost_dollars) - n(s.fee_cost));
}

/** Mark an open netted position at the bid: positive = YES contracts, negative = NO contracts. */
export function markPosition(p: RawPosition, market: Pick<RawMarket, "yes_bid_dollars" | "no_bid_dollars"> | null) {
  const qty = n(p.position_fp);
  const cost = n(p.market_exposure_dollars);
  const fees = n(p.fees_paid_dollars);
  const bid = market ? (qty >= 0 ? n(market.yes_bid_dollars) : n(market.no_bid_dollars)) : null;
  const value = bid == null ? null : r2(Math.abs(qty) * bid);
  return {
    side: qty >= 0 ? "YES" : "NO",
    contracts: Math.abs(qty),
    avgPrice: qty ? r2((cost / Math.abs(qty)) * 100) / 100 : null,
    cost: r2(cost),
    fees: r2(fees),
    bid,
    value,
    unrealized: value == null ? null : r2(value - cost - fees),
  };
}

/** Order as sent: action, side and that side's limit price. On netted accounts "sell YES" with no YES held opens NO. */
export function describeOrder(o: RawOrder): { verb: string; price: number; count: number } {
  const side = o.side === "no" ? "no" : "yes";
  return {
    verb: `${o.action === "sell" ? "sell" : "buy"} ${side.toUpperCase()}`,
    price: side === "no" ? n(o.no_price_dollars) : n(o.yes_price_dollars),
    count: n(o.initial_count_fp),
  };
}

/** Observable habits of the outside activity. A behavior description, not code. */
export function fingerprint(outsideOrders: RawOrder[], outsideTransfers: RawTransfer[]) {
  const sorted = [...outsideOrders].sort((a, b) => Date.parse(a.created_time || "") - Date.parse(b.created_time || ""));
  const market = sorted.filter((o) => o.type === "market").length;
  const fractional = sorted.filter((o) => !Number.isInteger(n(o.initial_count_fp))).length;
  let takeProfitAfterBuy = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const o = sorted[i];
    if (o.action !== "buy") continue;
    const t = Date.parse(o.created_time || "");
    const follow = sorted.find((x) => x.ticker === o.ticker && x.action === "sell" && x.type === "limit"
      && Date.parse(x.created_time || "") >= t && Date.parse(x.created_time || "") - t <= 120_000);
    if (follow) takeProfitAfterBuy += 1;
  }
  const orderSeconds = new Set(sorted.map((o) => Math.floor(Date.parse(o.created_time || "") / 1000)));
  const fundedSameSecond = outsideTransfers.filter((t) => t.created_ts != null && orderSeconds.has(Number(t.created_ts))).length;
  const series = new Map<string, number>();
  for (const o of sorted) {
    const s = o.ticker.split("-")[0];
    series.set(s, (series.get(s) ?? 0) + 1);
  }
  return {
    orders: sorted.length,
    marketOrders: market,
    limitOrders: sorted.length - market,
    fractionalSizes: fractional,
    takeProfitSellWithin2MinOfBuy: takeProfitAfterBuy,
    transfersSameSecondAsOrder: fundedSameSecond,
    series: [...series.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
  };
}

export const LOGIC_SUMMARY = [
  "No source code for a bot named \"momentum-bot-btc15\" was found in Samuel's Replit apps, GitHub repos, Lovable project, Vercel project, or the Grok Bot box (checked Nov 18, 2026).",
  "The only BTC15 code found (kalshi_btc15m_bot on Replit and GitHub, and this repo's BTC 15 desk) is paper/forecast only and has no order path.",
  "So this panel cannot show the bot's code. It shows what the account itself proves: every order with an empty client_order_id, the positions and fills those orders created, and shard transfers with no client_transfer_id.",
  "The fingerprint below is measured from those orders, not read from code.",
];

export function readOnlyGet(signed: Signed): (env: Env, path: string) => Promise<unknown> {
  return async (env, path) => {
    const { status, body } = await signed(env, "GET", path);
    if (status >= 400) {
      const message = typeof body === "object" && body && "message" in body ? String((body as { message?: unknown }).message) : `HTTP ${status}`;
      throw new Error(`${path.split("?")[0]}: ${message}`);
    }
    return body;
  };
}

async function paged<T>(get: (env: Env, path: string) => Promise<unknown>, env: Env, base: string, key: string, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page += 1) {
    const sep = base.includes("?") ? "&" : "?";
    const body = (await get(env, `${base}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""}`)) as Record<string, unknown>;
    const rows = body?.[key];
    if (Array.isArray(rows)) out.push(...(rows as T[]));
    cursor = typeof body?.cursor === "string" ? body.cursor : "";
    if (!cursor) break;
  }
  return out;
}

export type OutsideDeps = {
  signed?: Signed;
  market?: (ticker: string) => Promise<RawMarket | null>;
  now?: () => number;
};

export async function readOutsideActivity(env: Env, hours = 24, deps: OutsideDeps = {}) {
  if (!keysConfigured(env)) return { needsKey: true as const };
  const get = readOnlyGet(deps.signed ?? signedKalshi);
  const market = deps.market ?? ((ticker: string) => fetchMarket(ticker));
  const now = (deps.now ?? Date.now)();
  const span = Math.min(168, Math.max(1, Math.round(hours)));
  const minTs = Math.floor(now / 1000) - span * 3600;
  const prefix = env.MOMENTUM_BOT_CLIENT_ORDER_PREFIX?.trim() || undefined;
  const errors: string[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); return fallback; }
  };

  const [orders, resting, fills, positionsBody, settlements, transfers] = await Promise.all([
    safe("orders", () => paged<RawOrder>(get, env, `/portfolio/orders?min_ts=${minTs}&limit=200`, "orders"), []),
    safe("resting", () => paged<RawOrder>(get, env, "/portfolio/orders?status=resting&limit=200", "orders"), []),
    safe("fills", () => paged<RawFill>(get, env, `/portfolio/fills?min_ts=${minTs}&limit=200`, "fills"), []),
    safe("positions", () => get(env, "/portfolio/positions?limit=1000&count_filter=position"), {} as unknown),
    safe("settlements", () => paged<RawSettlement>(get, env, `/portfolio/settlements?min_ts=${minTs}&limit=200`, "settlements"), []),
    safe("transfers", () => paged<RawTransfer>(get, env, "/portfolio/intra_exchange_instance_transfers?limit=200", "transfers", 2), []),
  ]);
  const positions = ((positionsBody as { market_positions?: RawPosition[] })?.market_positions ?? []).filter((p) => n(p.position_fp) !== 0);

  // Attribute open positions whose orders are older than the window.
  const allOrders = [...orders, ...resting.filter((r) => !orders.some((o) => o.order_id === r.order_id))];
  const origins = tickerOrigins(allOrders, prefix);
  const unknown = positions.filter((p) => !origins.has(p.ticker)).slice(0, 25);
  for (const p of unknown) {
    const older = await safe(`orders ${p.ticker}`, () => paged<RawOrder>(get, env, `/portfolio/orders?ticker=${encodeURIComponent(p.ticker)}&limit=200`, "orders", 2), []);
    allOrders.push(...older);
  }
  const fullOrigins = tickerOrigins(allOrders, prefix);
  const orderById = new Map(allOrders.map((o) => [o.order_id, o]));
  const isOutside = (o: RawOrder) => orderOrigin(o, prefix) !== "desk";

  const outsideOrders = orders.filter(isOutside);
  const outsideResting = resting.filter(isOutside);
  const outsideFills = fills.filter((f) => { const o = orderById.get(f.order_id); return o ? isOutside(o) : false; });
  const unattributedFills = fills.filter((f) => !orderById.has(f.order_id)).length;
  const outsideTickers = new Set([...fullOrigins].filter(([, origin]) => origin !== "desk").map(([t]) => t));

  const openRows = await Promise.all(positions.filter((p) => outsideTickers.has(p.ticker)).map(async (p) => {
    const m = await safe(`market ${p.ticker}`, () => market(p.ticker), null);
    return { ticker: p.ticker, title: m?.yes_sub_title || m?.title || "", origin: fullOrigins.get(p.ticker) ?? "unknown", shard: shardLabel(Number(p.exchange_index ?? 0)), ...markPosition(p, m) };
  }));
  const settledRows = settlements.filter((s) => outsideTickers.has(s.ticker)).map((s) => ({
    ticker: s.ticker, result: s.market_result ?? "", settledAt: s.settled_time ?? "", origin: fullOrigins.get(s.ticker) ?? "unknown", pnl: settledPnl(s),
  }));
  const windowTransfers = transfers.filter((t) => n(t.created_ts) >= minTs);
  const outsideTransfers = windowTransfers.filter((t) => !(t.client_transfer_id ?? "").trim());

  const settledTotal = r2(settledRows.reduce((sum, row) => sum + row.pnl, 0));
  const openTotal = openRows.every((row) => row.unrealized != null) ? r2(openRows.reduce((sum, row) => sum + (row.unrealized ?? 0), 0)) : null;

  return {
    needsKey: false as const,
    readOnly: true,
    checkedAt: new Date(now).toISOString(),
    windowHours: span,
    momentumPrefix: prefix ?? null,
    note: "Kalshi does not report which API key placed an order. \"Outside\" = empty client_order_id: another key, the Kalshi app, or kalshi.com.",
    logic: LOGIC_SUMMARY,
    fingerprint: fingerprint(outsideOrders, outsideTransfers),
    openPositions: openRows,
    restingOrders: outsideResting.map((o) => ({ ...describeOrder(o), ticker: o.ticker, type: o.type ?? "", remaining: n(o.remaining_count_fp), createdAt: o.created_time ?? "", shard: shardLabel(Number(o.exchange_index ?? 0)) })),
    orders: outsideOrders.map((o) => ({ ...describeOrder(o), ticker: o.ticker, type: o.type ?? "", status: o.status ?? "", filled: n(o.fill_count_fp), createdAt: o.created_time ?? "", origin: orderOrigin(o, prefix) })),
    fills: outsideFills.map((f) => ({ ticker: f.ticker, action: f.action ?? "", side: f.side ?? "", count: n(f.count_fp), yesPrice: n(f.yes_price_dollars), fee: n(f.fee_cost), taker: Boolean(f.is_taker), createdAt: f.created_time ?? "" })),
    unattributedFills,
    settled: settledRows,
    transfers: outsideTransfers.map((t) => ({ amount: n(t.amount), from: shardLabel(Number(t.source_exchange_shard ?? 0)), to: shardLabel(Number(t.destination_exchange_shard ?? 0)), status: t.status ?? "", at: t.created_ts ? new Date(Number(t.created_ts) * 1000).toISOString() : "" })),
    deskTransfers: windowTransfers.length - outsideTransfers.length,
    pnl: { settled: settledTotal, openAtBid: openTotal, total: openTotal == null ? null : r2(settledTotal + openTotal) },
    errors,
  };
}

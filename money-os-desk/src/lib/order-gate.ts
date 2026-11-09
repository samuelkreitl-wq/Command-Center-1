/**
 * Server-side confirm gate. The execute path accepts only a matching, unexpired,
 * unused proposal plus confirm: true. Caps, the kill switch, and a live-price
 * recheck are enforced here, not only in the UI.
 */

import { createHash } from "node:crypto";

export type OrderIntent = {
  ticker: string;
  side: "yes" | "no";
  action: "buy";
  count: number;
  limitPrice: number;
  clientOrderId: string;
};

export type Proposal = {
  id: string;
  order: OrderIntent;
  orderHash: string;
  expiresAt: number;
  used: boolean;
  cancelled: boolean;
  confirmed: boolean;
  meta: Record<string, unknown>;
};

export const DEFAULT_TTL_MS = 60_000;
export const DEFAULT_MAX_CONTRACTS = 10;
export const DEFAULT_MAX_COST = 10;
export const DEFAULT_PRICE_TOLERANCE = 0.02;

export function canonicalOrder(order: OrderIntent): string {
  return JSON.stringify({
    action: order.action,
    clientOrderId: order.clientOrderId,
    count: order.count,
    limitPrice: Number(order.limitPrice.toFixed(4)),
    side: order.side,
    ticker: order.ticker,
  });
}

export function hashOrder(order: OrderIntent): string {
  return createHash("sha256").update(canonicalOrder(order)).digest("hex");
}

export function orderCost(order: Pick<OrderIntent, "count" | "limitPrice">): number {
  return order.count * order.limitPrice;
}

export function overCap(order: Pick<OrderIntent, "count" | "limitPrice">, maxContracts = DEFAULT_MAX_CONTRACTS, maxCost = DEFAULT_MAX_COST): boolean {
  if (!Number.isInteger(order.count) || order.count < 1) return true;
  if (!(order.limitPrice > 0) || order.limitPrice >= 1) return true;
  return order.count > maxContracts || orderCost(order) > maxCost + 1e-9;
}

export function assessExecute(input: {
  confirm: unknown;
  proposal: Proposal | null;
  orderHash: string;
  now: number;
  tradingEnabled: boolean;
  freshAsk: number | null;
  tolerance?: number;
  maxContracts?: number;
  maxCost?: number;
  positionBlocked: boolean;
  modeAllowsLive: boolean;
}): { ok: true } | { ok: false; reason: string; message: string } {
  if (input.confirm !== true) return { ok: false, reason: "no_confirm", message: "Explicit confirmation is required." };
  if (!input.proposal) return { ok: false, reason: "missing", message: "Unknown proposal." };
  if (input.orderHash !== input.proposal.orderHash) return { ok: false, reason: "tampered", message: "The order does not match the proposal." };
  if (input.now >= input.proposal.expiresAt) return { ok: false, reason: "expired", message: "The proposal expired." };
  if (input.proposal.used || input.proposal.cancelled) return { ok: false, reason: "reused", message: "That proposal was already used." };
  if (overCap(input.proposal.order, input.maxContracts, input.maxCost)) return { ok: false, reason: "over_cap", message: "The order is over the contract or cost cap." };
  if (!input.tradingEnabled) return { ok: false, reason: "trading_disabled", message: "TRADING_ENABLED is off." };
  if (!input.modeAllowsLive) return { ok: false, reason: "mode_paper", message: "Desk mode is paper. Real and demo orders stay off." };
  if (input.positionBlocked) return { ok: false, reason: "position_held", message: `Position already held on ${input.proposal.order.ticker}` };
  const tolerance = input.tolerance ?? DEFAULT_PRICE_TOLERANCE;
  if (input.freshAsk == null || Math.abs(input.freshAsk - input.proposal.order.limitPrice) > tolerance) {
    return { ok: false, reason: "price_moved", message: "The live ask moved beyond the tolerance. Nothing was sent." };
  }
  return { ok: true };
}

export function isPaperProposalId(id: string): boolean {
  return id.startsWith("paper_");
}

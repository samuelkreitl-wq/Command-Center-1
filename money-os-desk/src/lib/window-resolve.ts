/**
 * A spoken clock time is the KXBTC15M close, America/New_York.
 * 1:15 means the 1:00–1:15 window (ticker …0115-15), never the 1:15–1:30 window (…0130-30).
 * With no AM/PM, pick the nearest close that is still ahead today. Never roll to tomorrow
 * and never substitute a different quarter.
 */

import { sameEtDay, zonedParts, zonedTimeToUtc } from "./et-time";

export const QUARTER_MINUTES = new Set([0, 15, 30, 45]);

export type ListedMarket = {
  ticker: string;
  status: string;
  floorStrike: number | null;
  closeTime: string;
  openTime?: string;
  yesAsk: number;
  noAsk: number;
  yesBid: number;
  noBid: number;
  title?: string;
  series?: string;
  result?: string;
  expirationValue?: string;
};

export type ResolvedWindow =
  | { ok: true; close: Date; hour24: number; minute: number; market: ListedMarket }
  | { ok: false; reason: "not_quarter" | "closed" | "cannot_resolve" | "not_open" | "bad_time"; message: string; close?: Date };

export function closeSuffix(hour24: number, minute: number): string {
  const hh = String(hour24).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${hh}${mm}-${mm}`;
}

export function tickerCloseSuffix(ticker: string): string | null {
  const match = ticker.match(/(\d{2})(00|15|30|45)-\2$/);
  return match ? `${match[1]}${match[2]}-${match[2]}` : null;
}

export function resolveCloseInstant(
  time: { hour: number; minute: number; ampm?: "am" | "pm" },
  now: number,
): { ok: true; close: Date; hour24: number } | { ok: false; reason: "not_quarter" | "closed" | "bad_time"; message: string } {
  if (!QUARTER_MINUTES.has(time.minute)) {
    return {
      ok: false,
      reason: "not_quarter",
      message: `${time.hour}:${String(time.minute).padStart(2, "0")} is not a 15-minute close. Use :00, :15, :30, or :45.`,
    };
  }
  const today = zonedParts(new Date(now));
  const hours = candidateHours(time.hour, time.ampm);
  if (!hours) {
    return { ok: false, reason: "bad_time", message: "That clock time is not valid." };
  }
  const closes = hours.map((hour24) => ({
    hour24,
    close: zonedTimeToUtc(today.year, today.month, today.day, hour24, time.minute),
  })).filter((item) => sameEtDay(item.close, new Date(now)));
  const upcoming = closes.filter((item) => item.close.getTime() > now).sort((a, b) => a.close.getTime() - b.close.getTime());
  if (!upcoming.length) {
    return {
      ok: false,
      reason: "closed",
      message: "That window is already closed. The desk will not move the time to a later window.",
    };
  }
  return { ok: true, close: upcoming[0].close, hour24: upcoming[0].hour24 };
}

function candidateHours(hour: number, ampm?: "am" | "pm"): number[] | null {
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "am") return [hour === 12 ? 0 : hour];
    return [hour === 12 ? 12 : hour + 12];
  }
  if (hour === 0) return [0];
  if (hour > 23) return null;
  if (hour >= 13) return [hour];
  if (hour < 1) return null;
  if (hour === 12) return [0, 12];
  return [hour, hour + 12];
}

const OPEN_STATUS = new Set(["open", "active"]);
const CLOSED_STATUS = new Set(["closed", "settled", "finalized", "determined"]);

export function matchWindow(close: Date, hour24: number, minute: number, markets: ListedMarket[], now = Date.now()): ResolvedWindow {
  const want = zonedParts(close);
  const suffix = closeSuffix(hour24, minute);
  const sameClock = markets.filter((market) => {
    const at = Date.parse(market.closeTime);
    if (!Number.isFinite(at)) return false;
    const parts = zonedParts(new Date(at));
    return parts.year === want.year && parts.month === want.month && parts.day === want.day &&
      parts.hour === want.hour && parts.minute === want.minute;
  });
  const compatible = sameClock.filter((market) => {
    const got = tickerCloseSuffix(market.ticker);
    return got == null || got === suffix;
  });
  if (!compatible.length) {
    return {
      ok: false,
      reason: "cannot_resolve",
      message: `Cannot resolve the ${suffix} close to a live KXBTC15M market. A later window is not a substitute.`,
      close,
    };
  }
  const open = compatible.find((market) => OPEN_STATUS.has(market.status.toLowerCase()) && Date.parse(market.closeTime) > now);
  if (open) return { ok: true, close, hour24, minute, market: open };
  if (compatible.some((market) => CLOSED_STATUS.has(market.status.toLowerCase()) || Date.parse(market.closeTime) <= now)) {
    return { ok: false, reason: "closed", message: "That window is already closed.", close };
  }
  return {
    ok: false,
    reason: "not_open",
    message: "That window is not open yet. The desk will not switch to another window.",
    close,
  };
}

export function resolveSpokenWindow(
  time: { hour: number; minute: number; ampm?: "am" | "pm" },
  markets: ListedMarket[],
  now = Date.now(),
): ResolvedWindow {
  const instant = resolveCloseInstant(time, now);
  if (!instant.ok) return instant;
  return matchWindow(instant.close, instant.hour24, time.minute, markets, now);
}

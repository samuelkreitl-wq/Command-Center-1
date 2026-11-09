/** Kraken last-price freshness. The header uses the same 30s window as the desk spot. */

export const LIVE_PRICE_STALE_MS = 30_000;

export function isLivePriceStale(ts: number | null, now: number, error: boolean, maxAge = LIVE_PRICE_STALE_MS): boolean {
  if (error || ts == null) return true;
  return now - ts > maxAge;
}

export function parseKrakenLast(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const result = (data as { result?: Record<string, { c?: [string, string] }> }).result;
  if (!result) return null;
  const row = Object.values(result)[0];
  const last = Number(row?.c?.[0]);
  return Number.isFinite(last) && last > 0 ? last : null;
}

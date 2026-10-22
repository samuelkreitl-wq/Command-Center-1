/**
 * Crypto Fear & Greed Index (alternative.me) — public API, no key required.
 * https://api.alternative.me/fng/
 */

export interface FearGreedReading {
  value: number; // 0–100
  classification: string; // e.g. "Greed", "Extreme Fear"
  timestamp: number; // unix seconds
  timeUntilUpdate?: number; // seconds
}

export interface FearGreedSnapshot {
  current: FearGreedReading | null;
  yesterday?: FearGreedReading | null;
  lastWeek?: FearGreedReading | null;
  fetchedAt: number;
  error?: string;
}

const ENDPOINT = "https://api.alternative.me/fng/?limit=8";

export async function fetchFearGreed(): Promise<FearGreedSnapshot> {
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.metadata?.error) throw new Error(json.metadata.error);

    const data: any[] = json.data ?? [];
    const parse = (d: any): FearGreedReading | null => {
      if (!d) return null;
      return {
        value: Number(d.value),
        classification: d.value_classification ?? "Unknown",
        timestamp: Number(d.timestamp),
        timeUntilUpdate: d.time_until_update != null ? Number(d.time_until_update) : undefined,
      };
    };

    return {
      current: parse(data[0]),
      yesterday: parse(data[1]),
      lastWeek: parse(data[7]),
      fetchedAt: Date.now(),
    };
  } catch (e) {
    return {
      current: null,
      fetchedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

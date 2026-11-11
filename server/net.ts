const ALLOWED_HOSTS = new Set([
  "api.elections.kalshi.com",
  "api.kraken.com",
  "api.exchange.coinbase.com",
  "api.weather.gov",
  "api.open-meteo.com",
  "geocoding-api.open-meteo.com",
  "api.weather.com",
  "api.the-odds-api.com",
  "api.x.ai",
]);

export function assertAllowedUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Only https data sources are fetched");
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`Host is not a desk data source: ${parsed.hostname}`);
  return parsed;
}

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  assertAllowedUrl(url);
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "money-os-desk/1.0",
      ...(init?.headers || {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${new URL(url).hostname}`);
    (err as Error & { status?: number; body?: unknown }).status = res.status;
    (err as Error & { body?: unknown }).body = body;
    throw err;
  }
  return body;
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

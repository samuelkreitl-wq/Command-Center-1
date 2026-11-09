import { fetchKrakenLast, fetchMarkets } from "../server/public-data";
import { resolveSpokenWindow } from "../money-os-desk/src/lib/window-resolve";
import { formatEt } from "../money-os-desk/src/lib/et-time";
import { runPaperOnce } from "../server/paper-runner";
import { loadPrivateKeyPem } from "../money-os-desk/src/lib/kalshi-sign";

const env = { ...process.env };
delete env.KALSHI_API_BASE;
delete env.KALSHI_MARKET_BASE;
delete env.KRAKEN_API_BASE;

const markets = [
  ...await fetchMarkets(fetch, env, "KXBTC15M", "open"),
  ...await fetchMarkets(fetch, env, "KXBTC15M", "unopened").catch(() => []),
];
console.log("LIVE_MARKETS", markets.slice(0, 6).map((market) => ({
  ticker: market.ticker,
  status: market.status,
  close: market.closeTime,
  closeEt: formatEt(new Date(market.closeTime)),
  strike: market.floorStrike,
})));

const now = Date.now();
const sample = markets.find((market) => Date.parse(market.closeTime) > now);
if (sample) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hourCycle: "h12" }).formatToParts(new Date(sample.closeTime));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const day = parts.find((part) => part.type === "dayPeriod")?.value?.toLowerCase().startsWith("a") ? "am" as const : "pm" as const;
  const resolved = resolveSpokenWindow({ hour, minute }, markets, now);
  console.log("RESOLVE_SAMPLE", { hour, minute, day, ok: resolved.ok, ticker: resolved.ok ? resolved.market.ticker : resolved.message });
}
const closed = resolveSpokenWindow({ hour: 1, minute: 10 }, markets, now);
console.log("NON_QUARTER", closed.ok ? "unexpected" : closed.reason);
const spot = await fetchKrakenLast(fetch, env);
console.log("KRAKEN_SPOT", spot);
const paper = await runPaperOnce({ fetchImpl: fetch, env, now, rows: [], watches: {}, lastPollAt: null });
console.log("PAPER_ONCE", { feed: paper.feed, spot: paper.spot, rows: paper.rows.map((row) => ({ kind: row.kind, ticker: "ticker" in row ? row.ticker : "", reason: "reason" in row ? row.reason : "" })) });
const key = loadPrivateKeyPem(env);
console.log("DEMO_ORDER", key && env.KALSHI_API_KEY_ID ? "credentials present" : "unverified: set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY (or KALSHI_PRIVATE_KEY_PATH). No order was sent. KALSHI_ENV stays demo; production was not used.");

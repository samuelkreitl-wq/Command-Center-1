import { arbReturn, fairFromBooks, loadOdds, matchEvent } from "./sports.js";
import { fetchOpenMarkets, marketAsk, type RawMarket } from "./kalshi-public.js";
import { fetchJson, mapPool } from "./net.js";

const SERIES = ["KXNBAGAME", "KXNFLGAME", "KXNHLGAME", "KXMLBGAME", "KXNCAAFGAME", "KXNCAAMBGAME"];

export type ArbRow = {
  ticker: string;
  title: string;
  side: "YES";
  kalshiPrice: number;
  book: string;
  otherTeam: string;
  returnPct: number;
  depth: number;
  stale: boolean;
  verdict: "PASS" | "WATCH" | "FAIL";
  reason: string;
  updated: string;
  exchange_index?: number;
};

export async function findArbs(env: Record<string, string | undefined> = process.env, get: typeof fetchJson = fetchJson): Promise<{
  needsKey: boolean;
  error?: string;
  rows: ArbRow[];
  scannedAt: string;
}> {
  if (!env.ODDS_API_KEY) {
    return {
      needsKey: true,
      rows: [],
      scannedAt: new Date().toISOString(),
      error: "Sportsbook comparison needs ODDS_API_KEY. No lines were invented.",
    };
  }
  const odds = await loadOdds(env.ODDS_API_KEY, get);
  const batches = await mapPool(SERIES, 3, async (series) => {
    try {
      return await fetchOpenMarkets(series, get, 1);
    } catch {
      return [] as RawMarket[];
    }
  });
  const rows: ArbRow[] = [];
  for (const market of batches.flat()) {
    const matched = matchEvent(`${market.yes_sub_title || ""} ${market.title || ""} ${market.rules_primary || ""}`, odds.events);
    if (!matched) continue;
    const quote = fairFromBooks(matched.event, matched.team, Date.now());
    if (!quote) continue;
    if (quote.threeWay) {
      rows.push(row(market, quote.book, matched.other, 0, true, "FAIL", "A 3-way book line is not an arb against a 2-way Kalshi market.", quote.updated));
      continue;
    }
    const ask = marketAsk(market, "YES");
    const net = arbReturn({ kalshiPrice: ask.price, contracts: 1, otherDecimal: quote.decimalOther });
    if (net == null) continue;
    const pct = net * 100;
    const stale = quote.stale;
    let verdict: ArbRow["verdict"] = "FAIL";
    let reason = "Net return is under 1.5% after the Kalshi taker fee.";
    if (stale) reason = "STALE sportsbook quote (older than 5 minutes).";
    else if (!(ask.size >= 1)) reason = "No fillable Kalshi depth at the ask.";
    else if (pct >= 1.5) {
      verdict = "PASS";
      reason = "Both outcomes are covered and the worst-case fee still clears 1.5%. Sportsbook limits are unknown and assumed small.";
    } else if (pct > 0) {
      verdict = "WATCH";
      reason = "Positive before the 1.5% floor.";
    }
    if (verdict === "FAIL" && pct <= 0) continue;
    rows.push(row(market, quote.book, matched.other, pct, stale, verdict, reason, quote.updated));
  }
  rows.sort((a, b) => b.returnPct - a.returnPct);
  return { needsKey: false, error: odds.error, rows: rows.slice(0, 40), scannedAt: new Date().toISOString() };
}

function row(
  market: RawMarket,
  book: string,
  otherTeam: string,
  returnPct: number,
  stale: boolean,
  verdict: ArbRow["verdict"],
  reason: string,
  updated: string,
): ArbRow {
  const ask = marketAsk(market, "YES");
  return {
    ticker: market.ticker,
    title: market.title || market.ticker,
    side: "YES",
    kalshiPrice: ask.price,
    book,
    otherTeam,
    returnPct: Math.round(returnPct * 100) / 100,
    depth: ask.size,
    stale,
    verdict,
    reason,
    updated,
    exchange_index: market.exchange_index,
  };
}

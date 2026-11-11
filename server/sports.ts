import { americanToProb, conservativeDevig, takerFeeDollars } from "../money-os-desk/src/lib/pricing.js";
import { fetchJson } from "./net.js";

export type BookPrice = { book: string; updated: string; outcomes: Array<{ name: string; prob: number; decimal: number }> };

export type OddsEvent = {
  sport: string;
  home: string;
  away: string;
  commence: string;
  books: BookPrice[];
};

const SPORTS = [
  "basketball_nba",
  "americanfootball_nfl",
  "icehockey_nhl",
  "baseball_mlb",
  "basketball_ncaab",
  "americanfootball_ncaaf",
];

const ALIASES: Record<string, string> = {
  "los angeles c": "los angeles clippers",
  "los angeles l": "los angeles lakers",
  "la clippers": "los angeles clippers",
  "la lakers": "los angeles lakers",
  "ny knicks": "new york knicks",
  "ny nets": "brooklyn nets",
  "gs warriors": "golden state warriors",
  "sa spurs": "san antonio spurs",
  "no pelicans": "new orleans pelicans",
  "okc thunder": "oklahoma city thunder",
};

export async function loadOdds(apiKey: string | undefined, get: typeof fetchJson = fetchJson): Promise<{ events: OddsEvent[]; missingKey: boolean; error?: string }> {
  if (!apiKey) return { events: [], missingKey: true };
  const events: OddsEvent[] = [];
  const errors: string[] = [];
  for (const sport of SPORTS) {
    try {
      const rows = (await get(
        `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${encodeURIComponent(apiKey)}`,
      )) as Array<Record<string, unknown>>;
      for (const row of rows) events.push(normalizeEvent(sport, row));
    } catch (error) {
      errors.push(`${sport}: ${error instanceof Error ? error.message : "unavailable"}`);
    }
  }
  return { events, missingKey: false, error: errors.length ? errors.join("; ") : undefined };
}

function normalizeEvent(sport: string, row: Record<string, unknown>): OddsEvent {
  const books = Array.isArray(row.bookmakers) ? row.bookmakers : [];
  return {
    sport,
    home: String(row.home_team ?? ""),
    away: String(row.away_team ?? ""),
    commence: String(row.commence_time ?? ""),
    books: books.map((book) => {
      const entry = book as { key?: string; title?: string; last_update?: string; markets?: Array<{ key?: string; outcomes?: Array<{ name?: string; price?: number }> }> };
      const h2h = entry.markets?.find((market) => market.key === "h2h");
      const outcomes = (h2h?.outcomes ?? []).map((outcome) => {
        const american = Number(outcome.price);
        const prob = americanToProb(american) ?? 0;
        return { name: String(outcome.name ?? ""), prob, decimal: prob > 0 ? 1 / prob : 0 };
      }).filter((outcome) => outcome.decimal > 1);
      return { book: entry.key || entry.title || "book", updated: entry.last_update || "", outcomes };
    }).filter((book) => book.outcomes.length >= 2),
  };
}

export function canonicalTeam(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return ALIASES[cleaned] || cleaned;
}

export function matchEvent(text: string, events: OddsEvent[]): { event: OddsEvent; team: string; other: string } | null {
  const hay = canonicalTeam(text);
  let found: { event: OddsEvent; team: string; other: string; score: number } | null = null;
  for (const event of events) {
    for (const [team, other] of [[event.home, event.away], [event.away, event.home]] as const) {
      const name = canonicalTeam(team);
      if (!name || !hay.includes(name)) continue;
      const score = name.length;
      if (!found || score > found.score) found = { event, team, other, score };
    }
  }
  if (!found) return null;
  const home = canonicalTeam(found.event.home);
  const away = canonicalTeam(found.event.away);
  if (hay.includes(home) && hay.includes(away) && home !== away) {
    const wanted = canonicalTeam(text.split(" wins")[0] || text);
    if (wanted.includes(home) && !wanted.includes(away)) return { event: found.event, team: found.event.home, other: found.event.away };
    if (wanted.includes(away) && !wanted.includes(home)) return { event: found.event, team: found.event.away, other: found.event.home };
  }
  return { event: found.event, team: found.team, other: found.other };
}

export type DevigQuote = {
  fair: number;
  fairPower: number;
  fairMult: number;
  book: string;
  updated: string;
  stale: boolean;
  threeWay: boolean;
  decimalOther: number;
};

/** No-vig fair for `team`. Prefers Pinnacle, then Circa, then the median book. Uses the lower of the two vig methods. */
export function fairFromBooks(event: OddsEvent, team: string, nowMs: number): DevigQuote | null {
  const ranked = [...event.books].sort((a, b) => bookRank(a.book) - bookRank(b.book));
  for (const book of ranked) {
    const quote = quoteBook(book, team, nowMs);
    if (quote) return quote;
  }
  return null;
}

function bookRank(name: string): number {
  const key = name.toLowerCase();
  if (key.includes("pinnacle")) return 0;
  if (key.includes("circa")) return 1;
  return 2;
}

function quoteBook(book: BookPrice, team: string, nowMs: number): DevigQuote | null {
  const wanted = canonicalTeam(team);
  const outcomes = book.outcomes.map((outcome) => ({ ...outcome, name: canonicalTeam(outcome.name) }));
  const index = outcomes.findIndex((outcome) => outcome.name === wanted);
  if (index < 0) return null;
  const devig = conservativeDevig(outcomes.map((outcome) => outcome.prob));
  if (!devig) return null;
  const other = outcomes.find((outcome) => outcome.name !== wanted && outcome.name !== "draw");
  const age = book.updated ? nowMs - Date.parse(book.updated) : Number.POSITIVE_INFINITY;
  return {
    fair: devig.fair[index],
    fairPower: devig.power[index],
    fairMult: devig.multiplicative[index],
    book: book.book,
    updated: book.updated,
    stale: !(age >= 0) || age > 5 * 60_000,
    threeWay: outcomes.some((outcome) => outcome.name === "draw"),
    decimalOther: other?.decimal ?? 0,
  };
}

export function arbReturn(input: { kalshiPrice: number; contracts: number; otherDecimal: number; multiplier?: number }): number | null {
  if (!(input.otherDecimal > 1) || !(input.kalshiPrice > 0) || input.kalshiPrice >= 1) return null;
  const fee = takerFeeDollars(input.kalshiPrice, input.contracts, input.multiplier ?? 1) / input.contracts;
  const kalshiDecimal = 1 / (input.kalshiPrice + fee);
  const s = 1 / kalshiDecimal + 1 / input.otherDecimal;
  if (!(s > 0)) return null;
  return 1 / s - 1;
}

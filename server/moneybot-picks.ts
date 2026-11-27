import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { clearsEdgeThreshold, MIN_EDGE_CENTS, MIN_EDGE_PRICE_FRACTION } from "../money-os-desk/src/lib/pricing.js";
import { readStakeFloor, STAKE_FLOOR_NOTE } from "./moneybot-settings.js";

export const SHARED_SCANS_DIR = "/home/box/shared/money-desk/moneybot/data/scans";
export const SAMPLE_LABEL = "Sample fallback — no live scan file is on disk. These rows are not a live forecast.";
export const UNREADABLE_SAMPLE_LABEL = "Sample fallback — the latest scan file could not be read. These rows are not a live forecast.";
export const DRY_RUN_CONFIRMATION = "Dry Run Recorded";
export const POLYMARKET_BADGE = "Manual Review Only — Auto-Execution Parked";
export const POLYMARKET_PARKED_ERROR = "Polymarket auto-placement is parked. Manual Review Only — Auto-Execution Parked. Nothing was sent.";
export const POLYMARKET_KEYLESS_NOTE = "Polymarket scanning uses public keyless endpoints only. No API key is required or requested. Auto-execution stays parked.";
export const CLOB_TOKEN_WARNING = "No CLOB token id on this pick. Shown as scan-only. Nothing is sent.";

const TICKER = /^[A-Za-z0-9._-]{2,80}$/;

export type LiveProbe = () => void;

export type MoneybotPick = {
  id: string;
  title: string;
  ticker: string | null;
  recommended_side: "YES" | "NO" | null;
  verdict: "PASS" | "SKIP" | "WATCH" | "FAIL";
  ask: number | null;
  fair_prob: number | null;
  net_edge_cents: number | null;
  dynamic_bar_cents: number | null;
  edge_vs_bar_cents: number | null;
  clears_bar: boolean;
  quarter_kelly_usd: number | null;
  floor_usd: number;
  above_floor: boolean;
  eligible: boolean;
  reason: string;
  warnings: string[];
  url: string | null;
  venue: string | null;
  spread: number | null;
  manual_only: boolean;
  auto_execution: "parked" | "dry-run";
  scan_only: boolean;
  keyless: boolean;
  clob_token_ids: string[];
  plain: string;
  sample: boolean;
};

export type HourlyPayload = {
  source: "live" | "sample";
  sample: boolean;
  label: string | null;
  scanned_at: string | null;
  floor_usd: number;
  note: string;
  polymarket_auto_execution: "parked";
  polymarket_scan: "keyless";
  polymarket_keyless_note: string;
  picks: MoneybotPick[];
  catalog: Array<{ id: string; title: string; ticker: string | null; venue: string | null; manual_only: boolean }>;
};

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as RawRecord;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dollars(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cents(value: number): string {
  return `${value.toFixed(1)}¢`;
}

export function dynamicBarCents(price: number): number | null {
  if (!(price > 0) || price >= 1) return null;
  return Math.max(MIN_EDGE_CENTS, MIN_EDGE_PRICE_FRACTION * price * 100);
}

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function kalshiUrl(ticker: string | null): string | null {
  if (!ticker || !TICKER.test(ticker)) return null;
  return `https://kalshi.com/markets/${encodeURIComponent(ticker.toLowerCase())}`;
}

function sharedDirExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function resolveScansDir(
  env: Record<string, string | undefined>,
  dirExists: (dir: string) => boolean = sharedDirExists,
): string {
  const explicit = env.MONEYBOT_SCANS_DIR?.trim();
  if (explicit) return explicit;
  if (dirExists(SHARED_SCANS_DIR)) return SHARED_SCANS_DIR;
  return path.join(process.cwd(), "data", "moneybot", "scans");
}

export function resolveDryRunLog(env: Record<string, string | undefined>, scansDir = resolveScansDir(env)): string {
  const explicit = env.MONEYBOT_DRY_RUN_LOG?.trim();
  if (explicit) return explicit;
  return path.join(path.dirname(scansDir), "dry-runs.jsonl");
}

function latestScanFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(dir);
  } catch {
    return null;
  }
  if (!dirStat.isDirectory()) return null;
  const latest = path.join(dir, "latest.json");
  if (existsSync(latest)) {
    try {
      if (statSync(latest).isFile()) return latest;
    } catch {
      /* fall through to the newest json file */
    }
  }
  let newest: { file: string; mtime: number } | null = null;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      if (!newest || stat.mtimeMs > newest.mtime) newest = { file, mtime: stat.mtimeMs };
    } catch {
      /* skip an unreadable entry */
    }
  }
  return newest?.file ?? null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function venueOf(record: RawRecord): { venue: string | null; url: string | null } {
  const direct = safeHttpUrl(record.url) || safeHttpUrl(record.kalshi_url) || safeHttpUrl(record.polymarket_url);
  const venues = Array.isArray(record.venues) ? record.venues : [];
  for (const entry of venues) {
    const venue = asRecord(entry);
    if (!venue) continue;
    const name = asString(venue.venue);
    const url = safeHttpUrl(venue.url);
    if (url) return { venue: name, url };
    if (name) return { venue: name, url: direct };
  }
  return { venue: null, url: direct };
}

function stakeDollars(record: RawRecord): number | null {
  const direct = asNumber(record.quarter_kelly_usd);
  if (direct != null && direct >= 0) return direct;
  const suggestion = asRecord(record.stake_suggestion);
  const cost = suggestion ? asNumber(suggestion.cost_dollars) : null;
  if (cost != null && cost >= 0) return cost;
  return null;
}

function isPolymarketName(value: string | null): boolean {
  return value?.toLowerCase() === "polymarket";
}

function isPolymarketUrl(value: string | null): boolean {
  return !!value && value.toLowerCase().includes("polymarket.com");
}

function isPolymarketRecord(record: RawRecord): boolean {
  if (isPolymarketName(asString(record.venue))) return true;
  if (isPolymarketUrl(asString(record.url)) || isPolymarketUrl(asString(record.polymarket_url))) return true;
  const venues = Array.isArray(record.venues) ? record.venues : [];
  return venues.some((entry) => {
    const venue = asRecord(entry);
    return !!venue && (isPolymarketName(asString(venue.venue)) || isPolymarketUrl(asString(venue.url)));
  });
}

function spreadOf(record: RawRecord): number | null {
  const direct = asNumber(record.spread);
  if (direct != null && direct >= 0 && direct < 1) return direct;
  const venues = Array.isArray(record.venues) ? record.venues : [];
  for (const entry of venues) {
    const venue = asRecord(entry);
    const spread = venue ? asNumber(venue.spread) : null;
    if (spread != null && spread >= 0 && spread < 1) return spread;
  }
  const bid = asNumber(record.bid);
  const ask = asNumber(record.ask) ?? asNumber(record.price);
  if (bid != null && ask != null && ask > bid && ask < 1) return Math.round((ask - bid) * 10000) / 10000;
  return null;
}

export function readClobTokenIds(value: unknown): { ids: string[]; empty: boolean } {
  if (!Array.isArray(value)) return { ids: [], empty: true };
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) ids.push(item.trim());
  }
  return { ids, empty: ids.length === 0 };
}

function edgeCentsOf(record: RawRecord): number | null {
  const direct = asNumber(record.net_edge_cents);
  if (direct != null) return direct;
  const edge = asRecord(record.edge);
  return edge ? asNumber(edge.cents_per_contract_after_fees) : null;
}

function warningsOf(record: RawRecord): string[] {
  const warnings = [
    ...stringList(record.warnings),
    ...stringList(record.unverified),
  ];
  const proxy = asString(record.proxy_label);
  if (proxy) warnings.push(proxy);
  const trigger = asString(record.watch_trigger);
  if (trigger) warnings.push(trigger);
  const reality = asRecord(record.reality);
  if (reality) warnings.push(...stringList(reality.failed));
  return [...new Set(warnings)];
}

export function evaluatePick(record: RawRecord, floor: number, sample: boolean): MoneybotPick {
  const market = asRecord(record.market);
  const title = asString(market?.title) || asString(record.title) || "Untitled market";
  const ticker = asString(market?.ticker) || asString(record.ticker);
  const id = asString(record.id) || ticker || title;
  const sideRaw = asString(record.side)?.toUpperCase() || null;
  const recommended = sideRaw === "YES" || sideRaw === "NO" ? sideRaw : null;
  const ask = asNumber(record.price) ?? asNumber(record.ask);
  const fair = asNumber(record.fair_prob);
  const net = edgeCentsOf(record);
  const bar = ask != null ? dynamicBarCents(ask) : null;
  const clears = net != null && ask != null ? clearsEdgeThreshold(net, ask) : false;
  const kelly = stakeDollars(record);
  const above = kelly != null && kelly + 1e-9 >= floor;
  const original = asString(record.verdict)?.toUpperCase() || "PASS";
  const baseVerdict = original === "WATCH" || original === "FAIL" || original === "SKIP" || original === "PASS" ? original : "SKIP";
  const venueInfo = venueOf(record);
  const polymarket = isPolymarketRecord(record) || isPolymarketName(venueInfo.venue) || isPolymarketUrl(venueInfo.url);
  const url = venueInfo.url || (polymarket ? null : kalshiUrl(ticker));
  const venue = polymarket ? "polymarket" : (venueInfo.venue || (url ? "kalshi" : null));
  const spread = spreadOf(record);
  const tokens = readClobTokenIds(record.clob_token_ids ?? record.clobTokenIds);
  const warnings = warningsOf(record);
  if (polymarket && tokens.empty) warnings.push(CLOB_TOKEN_WARNING);

  let verdict: MoneybotPick["verdict"] = baseVerdict === "SKIP" ? "SKIP" : baseVerdict;
  let reason = "";
  if (!recommended) {
    verdict = "SKIP";
    reason = "No YES or NO side was on this pick, so nothing is suggested.";
  } else if (verdict === "FAIL") {
    reason = asString(stringList(record.reasons)[0]) || "The scan marked this market ineligible.";
  } else if (verdict === "WATCH") {
    reason = asString(record.watch_trigger)
      ? `Watch only. ${asString(record.watch_trigger)}`
      : "Watch only. This is not a suggested bet.";
  } else if (!clears) {
    verdict = "SKIP";
    reason = net != null && bar != null
      ? `Net edge is ${cents(net)}, under the ${cents(bar)} dynamic bar, so this is not a suggested bet.`
      : "Net edge against the dynamic bar was not on this pick, so it is skipped.";
  } else if (!above) {
    verdict = "SKIP";
    reason = kelly != null
      ? `Quarter-Kelly stake is ${dollars(kelly)}, under the ${dollars(floor)} floor. ${STAKE_FLOOR_NOTE}.`
      : `No quarter-Kelly stake was on this pick. The ${dollars(floor)} floor is not used to raise it. ${STAKE_FLOOR_NOTE}.`;
  } else {
    verdict = "PASS";
    reason = "Clears the dynamic bar and the stake floor.";
  }
  if (polymarket && verdict === "PASS") {
    reason = `${POLYMARKET_BADGE}. Open the Polymarket link to place this yourself. Nothing is sent from this desk.`;
  }

  const eligible = !polymarket && verdict === "PASS" && recommended != null && clears && above;
  const sideText = recommended ? `${recommended} on ${title}` : title;
  const askText = ask != null ? `Ask ${cents(ask * 100)} (${ask.toFixed(2)}).` : "Ask was not on the scan.";
  const spreadText = spread != null ? `Spread ${cents(spread * 100)}.` : "";
  const fairText = fair != null ? `Model fair ${(fair * 100).toFixed(1)}%.` : "Model fair probability was not on the scan.";
  const edgeText = net != null && bar != null
    ? `Net edge ${cents(net)} versus a ${cents(bar)} dynamic bar.`
    : "Net edge versus the dynamic bar was not on the scan.";
  const stakeText = kelly != null
    ? `Quarter-Kelly stake ${dollars(kelly)} against the ${dollars(floor)} floor.`
    : `No quarter-Kelly stake was listed. The ${dollars(floor)} floor is not used to raise it.`;
  const plain = [sideText + ".", askText, spreadText, fairText, edgeText, stakeText].filter(Boolean).join(" ");

  return {
    id,
    title,
    ticker,
    recommended_side: recommended,
    verdict,
    ask,
    fair_prob: fair,
    net_edge_cents: net,
    dynamic_bar_cents: bar,
    edge_vs_bar_cents: net != null && bar != null ? Math.round((net - bar) * 10) / 10 : null,
    clears_bar: clears,
    quarter_kelly_usd: kelly,
    floor_usd: floor,
    above_floor: above,
    eligible,
    reason,
    warnings,
    url,
    venue,
    spread,
    manual_only: polymarket,
    auto_execution: polymarket ? "parked" : "dry-run",
    scan_only: polymarket,
    keyless: polymarket,
    clob_token_ids: tokens.ids,
    plain,
    sample,
  };
}

const SAMPLE_RECORDS: RawRecord[] = [
  {
    id: "sample-nyc-high",
    title: "Sample: New York high above 70°F",
    ticker: "SAMPLE-NYC-70",
    side: "YES",
    price: 0.4,
    fair_prob: 0.58,
    verdict: "PASS",
    net_edge_cents: 12,
    quarter_kelly_usd: 18,
    url: "https://kalshi.com/markets/sample-nyc-70",
    warnings: ["Sample model only. Not a live forecast."],
    summary: "Sample illustration of a pick that clears a $5 floor.",
  },
  {
    id: "sample-btc-round",
    title: "Sample: Bitcoin above a round strike",
    ticker: "SAMPLE-BTC-ROUND",
    side: "NO",
    price: 0.46,
    fair_prob: 0.61,
    verdict: "PASS",
    net_edge_cents: 8,
    quarter_kelly_usd: 2,
    venues: [{ venue: "kalshi", url: "https://kalshi.com/markets/sample-btc-round" }],
    warnings: ["Sample model only. The stake is under a $5 floor on purpose."],
  },
  {
    id: "sample-poly",
    title: "Sample: Polymarket illustrated contract",
    ticker: "SAMPLE-POLY",
    side: "YES",
    price: 0.42,
    spread: 0.03,
    fair_prob: 0.55,
    verdict: "PASS",
    net_edge_cents: 8,
    quarter_kelly_usd: 12,
    venues: [{ venue: "polymarket", url: "https://polymarket.com/event/sample-illustrated", spread: 0.03 }],
    clob_token_ids: [],
    warnings: ["Sample model only. Auto-execution is parked."],
  },
];

function samplePayload(floor: number, label: string): HourlyPayload {
  const picks = SAMPLE_RECORDS.map((record) => evaluatePick(record, floor, true));
  return {
    source: "sample",
    sample: true,
    label,
    scanned_at: null,
    floor_usd: floor,
    note: STAKE_FLOOR_NOTE,
    polymarket_auto_execution: "parked",
    polymarket_scan: "keyless",
    polymarket_keyless_note: POLYMARKET_KEYLESS_NOTE,
    picks,
    catalog: picks.map(catalogRow),
  };
}

function catalogRow(pick: MoneybotPick): HourlyPayload["catalog"][number] {
  return { id: pick.id, title: pick.title, ticker: pick.ticker, venue: pick.venue, manual_only: pick.manual_only };
}

function collectRecords(parsed: unknown): { suggested: RawRecord[]; catalog: RawRecord[]; scannedAt: string | null } | null {
  if (Array.isArray(parsed)) {
    const rows = parsed.map(asRecord).filter((row): row is RawRecord => row != null);
    return { suggested: rows, catalog: rows, scannedAt: null };
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const scannedAt = asString(root.finishedAt) || asString(root.scanned_at) || asString(root.scannedAt);
  const pass = Array.isArray(root.pass) ? root.pass.map(asRecord).filter((row): row is RawRecord => row != null) : [];
  const saved = Array.isArray(root.saved) ? root.saved.map(asRecord).filter((row): row is RawRecord => row != null) : [];
  const picks = Array.isArray(root.picks) ? root.picks.map(asRecord).filter((row): row is RawRecord => row != null) : [];
  const watch = Array.isArray(root.watch) ? root.watch.map(asRecord).filter((row): row is RawRecord => row != null) : [];
  const fail = Array.isArray(root.fail) ? root.fail.map(asRecord).filter((row): row is RawRecord => row != null) : [];
  const markets = Array.isArray(root.markets) ? root.markets.map(asRecord).filter((row): row is RawRecord => row != null) : [];
  const catalog = Array.isArray(root.catalog) ? root.catalog.map(asRecord).filter((row): row is RawRecord => row != null) : [];
  const suggested = picks.length ? picks : [...pass, ...saved];
  const all = [...suggested, ...watch, ...fail, ...markets, ...catalog];
  if (!all.length && !scannedAt && !("pass" in root) && !("picks" in root)) return null;
  return { suggested, catalog: all.length ? all : suggested, scannedAt };
}

export function readHourly(env: Record<string, string | undefined> = process.env): HourlyPayload {
  const floor = readStakeFloor(env).min_stake_usd;
  const file = latestScanFile(resolveScansDir(env));
  if (!file) return samplePayload(floor, SAMPLE_LABEL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return samplePayload(floor, UNREADABLE_SAMPLE_LABEL);
  }
  const collected = collectRecords(parsed);
  if (!collected) return samplePayload(floor, UNREADABLE_SAMPLE_LABEL);
  const seen = new Set<string>();
  const picks: MoneybotPick[] = [];
  for (const record of collected.suggested) {
    const pick = evaluatePick(record, floor, false);
    const key = `${pick.id}::${pick.recommended_side || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(pick);
  }
  const catalogSource = collected.catalog.length ? collected.catalog : collected.suggested;
  for (const record of catalogSource) {
    if (!isPolymarketRecord(record)) continue;
    const pick = evaluatePick(record, floor, false);
    const key = `${pick.id}::${pick.recommended_side || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(pick);
  }
  const catalogSeen = new Set<string>();
  const catalog: HourlyPayload["catalog"] = [];
  for (const record of catalogSource) {
    const pick = evaluatePick(record, floor, false);
    if (catalogSeen.has(pick.id)) continue;
    catalogSeen.add(pick.id);
    catalog.push(catalogRow(pick));
  }
  return {
    source: "live",
    sample: false,
    label: null,
    scanned_at: collected.scannedAt,
    floor_usd: floor,
    note: STAKE_FLOOR_NOTE,
    polymarket_auto_execution: "parked",
    polymarket_scan: "keyless",
    polymarket_keyless_note: POLYMARKET_KEYLESS_NOTE,
    picks,
    catalog,
  };
}

function scoreMatch(pick: MoneybotPick, query: string): number {
  const q = query.toLowerCase();
  if (pick.id.toLowerCase() === q) return 100;
  if (pick.ticker && pick.ticker.toLowerCase() === q) return 90;
  if (pick.title.toLowerCase() === q) return 80;
  if (pick.title.toLowerCase().includes(q)) return 50;
  if (pick.ticker && pick.ticker.toLowerCase().includes(q)) return 40;
  if (pick.id.toLowerCase().includes(q)) return 30;
  return 0;
}

export function suggestMarket(env: Record<string, string | undefined>, query: string): {
  status: number;
  body: Record<string, unknown>;
} {
  const q = query.trim();
  if (!q) return { status: 400, body: { error: "Enter a market title or ticker." } };
  const hourly = readHourly(env);
  const floor = hourly.floor_usd;
  const file = hourly.sample ? null : latestScanFile(resolveScansDir(env));
  const records = hourly.sample
    ? SAMPLE_RECORDS
    : file
      ? recordsFromFile(file)
      : [];
  const ranked = records
    .map((record) => evaluatePick(record, floor, hourly.sample))
    .map((pick) => ({ pick, score: scoreMatch(pick, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    return { status: 404, body: { error: "No market in the latest scan matches that search.", sample: hourly.sample, label: hourly.label } };
  }
  const top = ranked[0].score;
  const tied = ranked.filter((row) => row.score === top);
  if (tied.length > 1 && top < 80) {
    return {
      status: 200,
      body: {
        ambiguous: true,
        sample: hourly.sample,
        label: hourly.label,
        floor_usd: floor,
        matches: tied.map(({ pick }) => ({ id: pick.id, title: pick.title, ticker: pick.ticker, venue: pick.venue })),
      },
    };
  }
  return {
    status: 200,
    body: {
      ambiguous: false,
      sample: hourly.sample,
      label: hourly.label,
      source: hourly.source,
      floor_usd: floor,
      pick: tied[0].pick,
    },
  };
}

function recordsFromFile(file: string): RawRecord[] {
  try {
    const collected = collectRecords(JSON.parse(readFileSync(file, "utf8")));
    return collected?.catalog ?? [];
  } catch {
    return [];
  }
}

function requestsLive(body: RawRecord): boolean {
  return body.live === true || body.execute === true || body.place_live === true || body.confirm === true;
}

function bodyTargetsPolymarket(body: RawRecord): boolean {
  if (isPolymarketName(asString(body.venue))) return true;
  if (isPolymarketUrl(asString(body.url)) || isPolymarketUrl(asString(body.polymarket_url))) return true;
  return false;
}

function parkedPolymarket(): { status: number; body: Record<string, unknown> } {
  return {
    status: 403,
    body: {
      ok: false,
      dry_run: true,
      live: false,
      executed: false,
      auto_execution: "parked",
      manual_only: true,
      error: POLYMARKET_PARKED_ERROR,
    },
  };
}

export function listDryRuns(env: Record<string, string | undefined>, limit = 20): Array<Record<string, unknown>> {
  const file = resolveDryRunLog(env);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line) as Record<string, unknown>).reverse();
  } catch {
    return [];
  }
}

/**
 * Records a simulated order. Live execution is not available on this path:
 * the optional probe exists so tests can prove it is never called.
 */
export function recordDryRun(
  env: Record<string, string | undefined>,
  body: RawRecord,
  liveProbe?: LiveProbe,
): { status: number; body: Record<string, unknown> } {
  void liveProbe;
  if (bodyTargetsPolymarket(body)) return parkedPolymarket();
  if (requestsLive(body)) {
    return {
      status: 403,
      body: {
        ok: false,
        dry_run: true,
        live: false,
        executed: false,
        error: "Live execution is disabled. Nothing was sent.",
      },
    };
  }
  const hourly = readHourly(env);
  const id = asString(body.id) || asString(body.ticker) || asString(body.market);
  if (!id) return { status: 400, body: { ok: false, dry_run: true, live: false, executed: false, error: "A pick id is required. Nothing was sent." } };
  const suggestion = suggestMarket(env, id);
  const pick = suggestion.status === 200 && suggestion.body.pick && typeof suggestion.body.pick === "object"
    ? suggestion.body.pick as MoneybotPick
    : null;
  if (!pick) {
    return { status: 404, body: { ok: false, dry_run: true, live: false, executed: false, error: "That pick is not in the latest scan. Nothing was sent." } };
  }
  if (pick.manual_only || pick.venue === "polymarket" || isPolymarketUrl(pick.url)) return parkedPolymarket();
  if (!pick.eligible) {
    return {
      status: 400,
      body: {
        ok: false,
        dry_run: true,
        live: false,
        executed: false,
        error: pick.reason || "This pick is not eligible. Nothing was sent.",
        pick,
      },
    };
  }
  const record = {
    at: new Date().toISOString(),
    dry_run: true,
    live: false,
    executed: false,
    confirmation: DRY_RUN_CONFIRMATION,
    id: pick.id,
    title: pick.title,
    ticker: pick.ticker,
    side: pick.recommended_side,
    ask: pick.ask,
    quarter_kelly_usd: pick.quarter_kelly_usd,
    floor_usd: pick.floor_usd,
    sample: pick.sample || hourly.sample,
  };
  const file = resolveDryRunLog(env);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return {
    status: 200,
    body: {
      ok: true,
      dry_run: true,
      live: false,
      executed: false,
      confirmation: DRY_RUN_CONFIRMATION,
      record,
    },
  };
}

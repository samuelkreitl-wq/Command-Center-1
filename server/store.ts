import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type DeskRecord = {
  schema_version: "1.0";
  id: string;
  source: "money-bot" | "arbitrage" | "reality-check" | "other";
  source_bot: string;
  created_at: string;
  market: {
    title: string;
    ticker?: string;
    event_ticker?: string;
    category?: string;
    window_start_et?: string;
    close_time_et?: string;
    settlement_source?: string;
    kalshi_shard?: number;
  };
  venues: Array<Record<string, unknown>>;
  side: string;
  price: number;
  fair_prob: number | null;
  fair_prob_source?: string;
  fair_prob_range?: [number, number];
  edge: { cents_per_contract_after_fees: number; pct_after_fees?: number; fee_dollars?: number };
  stake_suggestion: {
    contracts: number;
    cost_dollars: number;
    max_loss_dollars: number;
    max_profit_dollars?: number;
    method: string;
    cash_needed_on_shard?: Record<string, number>;
    transfer_needed?: string;
  };
  confidence: "low" | "medium" | "high";
  verdict: "PASS" | "FAIL" | "WATCH";
  watch_trigger?: string;
  reasons: string[];
  unverified?: string[];
  data_timestamps: Record<string, string>;
  stale_after?: Record<string, string>;
  expires_at: string;
  summary: [string, string, string];
  approval: "none" | "awaiting_samuel" | "approved_by_samuel" | "declined_by_samuel";
  shown_to_samuel: boolean;
  tab: string;
  model: string;
  proxy_label?: string;
  depth?: number | null;
  spread?: number | null;
  reality?: { verdict: "PASS" | "FAIL" | "WATCH"; failed: string[] };
  archive_note?: string;
};

const CSV_HEADER =
  "timestamp_et,tab,market_title,ticker,side,price,fair_prob,edge_cents_after_fees,stake_suggestion_contracts,stake_suggestion_dollars,verdict,reality_check_verdict,reality_check_path,shown_to_samuel,close_time_et,record_path";

export function deskRoot(env: Record<string, string | undefined> = process.env): string {
  return env.MONEY_DESK_DATA_DIR || path.join(process.cwd(), "data", "money-desk");
}

export function ensureDeskDirs(root: string): void {
  for (const dir of ["hourly", "saved-picks", "archive", "orders", "reality-check"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function hourFolder(root: string, et: Date): { dir: string; stamp: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(et);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = `${get("hour").padStart(2, "0")}00`;
  const dir = path.join(root, "hourly", day, hour);
  mkdirSync(dir, { recursive: true });
  return { dir, stamp: `${day}_${hour}` };
}

export function schemaBody(record: DeskRecord): Record<string, unknown> {
  const {
    tab: _tab, model: _model, proxy_label: _proxy, depth: _depth, spread: _spread,
    reality: _reality, shown_to_samuel: _shown, stale_after: _stale, archive_note: _note,
    ...schema
  } = record;
  return schema;
}

export function writeHourlyRecord(root: string, record: DeskRecord, now = new Date()): string {
  ensureDeskDirs(root);
  const { dir, stamp } = hourFolder(root, now);
  const slug = `${record.tab}-${(record.market.ticker || record.id).replace(/[^A-Za-z0-9]+/g, "-").slice(0, 80)}`;
  const filename = `${stamp}_money-bot_${slug}.json`;
  const full = path.join(dir, filename);
  writeFileSync(full, JSON.stringify(schemaBody(record), null, 2));
  const rel = path.relative(root, full);
  const csv = path.join(root, "hourly", "picks-log.csv");
  if (!existsSync(csv)) writeFileSync(csv, `${CSV_HEADER}\n`);
  const line = [
    record.created_at,
    record.tab,
    record.market.title,
    record.market.ticker ?? "",
    record.side,
    record.price,
    record.fair_prob ?? "",
    record.edge.cents_per_contract_after_fees,
    record.stake_suggestion.contracts,
    record.stake_suggestion.cost_dollars,
    record.verdict,
    record.reality?.verdict ?? "",
    rel,
    record.shown_to_samuel,
    record.market.close_time_et ?? "",
    rel,
  ].map(csvEscape).join(",");
  appendFileSync(csv, `${line}\n`);
  return full;
}

export function readJsonFiles(dir: string): DeskRecord[] {
  if (!existsSync(dir)) return [];
  const out: DeskRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, name), "utf8")) as DeskRecord);
    } catch {
      /* skip a torn write */
    }
  }
  return out;
}

export function writeSaved(root: string, record: DeskRecord, hourStamp: string): string {
  ensureDeskDirs(root);
  const base = `${record.id}__still-good_${hourStamp}.json`;
  const full = path.join(root, "saved-picks", base);
  writeFileSync(full, JSON.stringify(schemaBody(record), null, 2));
  return full;
}

export function archiveSaved(root: string, filename: string, record: DeskRecord, day: string): void {
  const dir = path.join(root, "archive", day);
  mkdirSync(dir, { recursive: true });
  const from = path.join(root, "saved-picks", filename);
  const target = path.join(dir, filename);
  writeFileSync(target, JSON.stringify(schemaBody(record), null, 2));
  writeFileSync(path.join(dir, `${filename}.note.txt`), `${record.archive_note || "archived"}\n`);
  if (existsSync(from)) {
    try {
      renameSync(from, path.join(dir, `moved-${filename}`));
    } catch {
      /* the archived copy above is the record of why it left */
    }
  }
}

export function listSavedFiles(root: string): string[] {
  const dir = path.join(root, "saved-picks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

export function readSaved(root: string, filename: string): DeskRecord | null {
  try {
    return JSON.parse(readFileSync(path.join(root, "saved-picks", filename), "utf8")) as DeskRecord;
  } catch {
    return null;
  }
}

export function appendOrderLog(root: string, entry: Record<string, unknown>): void {
  ensureDeskDirs(root);
  const clean = { ...entry };
  for (const key of Object.keys(clean)) {
    if (/password|secret|signature|private|authorization/i.test(key)) delete clean[key];
  }
  appendFileSync(path.join(root, "orders", "orders.jsonl"), `${JSON.stringify(clean)}\n`);
}

export function readOrderLog(root: string, limit = 50): Record<string, unknown>[] {
  const file = path.join(root, "orders", "orders.jsonl");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line) as Record<string, unknown>).reverse();
}

export function readHistory(root: string, limit = 200): string[][] {
  const file = path.join(root, "hourly", "picks-log.csv");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return lines.slice(1).slice(-limit).reverse().map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function etHourStamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}_${get("hour").padStart(2, "0")}00`;
}

export function etDay(now = new Date()): string {
  return etHourStamp(now).slice(0, 10);
}

export function isoEt(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const base = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const asUtc = new Date(`${base}Z`).getTime();
  const offsetMin = Math.round((asUtc - now.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${base}${sign}${hh}:${mm}`;
}

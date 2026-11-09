/**
 * JSONL is the dev fallback and is append-only for paper events.
 * Postgres is used when DATABASE_URL is set. SQLite is used when node:sqlite loads.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Pool } from "pg";

export interface DeskStore {
  appendPaper(row: unknown): Promise<void>;
  paperRows(): Promise<unknown[]>;
  appendJournal(row: unknown): Promise<void>;
  journalRows(limit?: number): Promise<unknown[]>;
  getKv(key: string): Promise<string | null>;
  setKv(key: string, value: string): Promise<void>;
  deleteKv(key: string): Promise<void>;
  close(): Promise<void>;
}

export async function openStore(opts: { driver?: "postgres" | "sqlite" | "jsonl"; path?: string; databaseUrl?: string } = {}): Promise<DeskStore> {
  const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;
  const driver = opts.driver || (databaseUrl ? "postgres" : process.env.DESK_STORE === "jsonl" ? "jsonl" : "sqlite");
  if (driver === "postgres") {
    if (!databaseUrl) throw new Error("DATABASE_URL is not set");
    return openPostgres(databaseUrl);
  }
  if (driver === "jsonl") return openJsonl(opts.path || process.env.DESK_JSONL_DIR || "data/jsonl");
  try {
    return await openSqlite(opts.path || process.env.DESK_SQLITE_PATH || "data/desk.sqlite");
  } catch {
    return openJsonl(opts.path || process.env.DESK_JSONL_DIR || "data/jsonl");
  }
}

async function openSqlite(path: string): Promise<DeskStore> {
  const { DatabaseSync } = await import("node:sqlite");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS paper_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      ticker TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const applied = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("001_init") as { id: string } | undefined;
  if (!applied) db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("001_init", new Date().toISOString());
  return {
    async appendPaper(row) {
      const record = row as { ts?: number; kind?: string; ticker?: string };
      db.prepare("INSERT INTO paper_events (ts, kind, ticker, payload) VALUES (?, ?, ?, ?)").run(String(record.ts ?? Date.now()), String(record.kind ?? "note"), record.ticker ?? null, JSON.stringify(row));
    },
    async paperRows() {
      return (db.prepare("SELECT payload FROM paper_events ORDER BY id ASC").all() as { payload: string }[]).map((row) => JSON.parse(row.payload));
    },
    async appendJournal(row) {
      const record = row as { ts?: number; kind?: string; ticker?: string };
      db.prepare("INSERT INTO journal (ts, kind, ticker, payload) VALUES (?, ?, ?, ?)").run(String(record.ts ?? Date.now()), String(record.kind ?? "note"), record.ticker ?? null, JSON.stringify(row));
    },
    async journalRows(limit = 200) {
      return (db.prepare("SELECT payload FROM journal ORDER BY id DESC LIMIT ?").all(limit) as { payload: string }[]).map((row) => JSON.parse(row.payload)).reverse();
    },
    async getKv(key) {
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    async setKv(key, value) {
      db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, new Date().toISOString());
    },
    async deleteKv(key) { db.prepare("DELETE FROM kv WHERE key = ?").run(key); },
    async close() { db.close(); },
  };
}

function openJsonl(dir: string): DeskStore {
  mkdirSync(dir, { recursive: true });
  const paperPath = `${dir}/paper-events.jsonl`;
  const journalPath = `${dir}/journal.jsonl`;
  const kvPath = `${dir}/kv.json`;
  const readLines = (path: string) => existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown)
    : [];
  const readKv = (): Record<string, string> => existsSync(kvPath) ? JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, string> : {};
  return {
    async appendPaper(row) { appendFileSync(paperPath, `${JSON.stringify(row)}\n`); },
    async paperRows() { return readLines(paperPath); },
    async appendJournal(row) { appendFileSync(journalPath, `${JSON.stringify(row)}\n`); },
    async journalRows(limit = 200) { return readLines(journalPath).slice(-limit); },
    async getKv(key) { return readKv()[key] ?? null; },
    async setKv(key, value) {
      const all = readKv();
      all[key] = value;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(kvPath, JSON.stringify(all));
    },
    async deleteKv(key) {
      const all = readKv();
      delete all[key];
      const { writeFileSync } = await import("node:fs");
      writeFileSync(kvPath, JSON.stringify(all));
    },
    async close() {},
  };
}

async function openPostgres(databaseUrl: string): Promise<DeskStore> {
  const loaded = await import("pg");
  const Pool = loaded.Pool ?? loaded.default?.Pool;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS paper_events (
      id BIGSERIAL PRIMARY KEY,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      ticker TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal (
      id BIGSERIAL PRIMARY KEY,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await pool.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", ["001_init"]);
  const insertSql = (table: string) => `INSERT INTO ${table} (ts, kind, ticker, payload) VALUES ($1, $2, $3, $4)`;
  return {
    async appendPaper(row) { await writePg(pool, insertSql("paper_events"), row); },
    async paperRows() { return readPg(pool, "paper_events"); },
    async appendJournal(row) { await writePg(pool, insertSql("journal"), row); },
    async journalRows(limit = 200) { return readPg(pool, "journal", limit); },
    async getKv(key) {
      const result = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
      return result.rows[0]?.value ?? null;
    },
    async setKv(key, value) {
      await pool.query(
        "INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
        [key, value, new Date().toISOString()],
      );
    },
    async deleteKv(key) { await pool.query("DELETE FROM kv WHERE key = $1", [key]); },
    async close() { await pool.end(); },
  };
}

async function writePg(pool: { query: (sql: string, params: unknown[]) => Promise<unknown> }, sql: string, row: unknown) {
  const record = row as { ts?: number; kind?: string; ticker?: string };
  await pool.query(sql, [String(record.ts ?? Date.now()), String(record.kind ?? "note"), record.ticker ?? null, JSON.stringify(row)]);
}

async function readPg(pool: Pool, table: string, limit = 5000) {
  const result = await pool.query(`SELECT payload FROM ${table} ORDER BY id ASC LIMIT $1`, [limit]);
  return result.rows.map((row) => JSON.parse(row.payload));
}

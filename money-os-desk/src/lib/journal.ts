import type { CoreLock, PaperTrade } from "./types";
import { settleCore } from "./signal-lock";
import { settlePaperTrade } from "./paper";

const LOCK_KEY = "moneyos.btc.journal.v1";
const TRADE_KEY = "moneyos.btc.trades.v1";
const CUSTOM_REF_KEY = "moneyos.btc.customRef";

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadLocks(): CoreLock[] {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    return raw ? (JSON.parse(raw) as CoreLock[]) : [];
  } catch {
    return [];
  }
}

export function saveLocks(rows: CoreLock[]): void {
  if (!canUseStorage()) return;
  localStorage.setItem(LOCK_KEY, JSON.stringify(rows));
}

/** Insert only if no open (unsettled) row for same windowId. */
export function appendLock(lock: CoreLock): CoreLock[] {
  const rows = loadLocks();
  const open = rows.find((r) => r.windowId === lock.windowId && !r.settledAt);
  if (open) return rows;
  const same = rows.find((r) => r.windowId === lock.windowId);
  if (same) return rows;
  rows.push(lock);
  saveLocks(rows);
  return rows;
}

export function settleLocksForWindow(
  windowId: string,
  endPx: number,
  strike: number
): CoreLock[] {
  const rows = loadLocks().map((r) => {
    if (r.windowId !== windowId || r.settledAt) return r;
    return settleCore({ ...r, strike: r.strike || strike }, endPx);
  });
  saveLocks(rows);
  return rows;
}

export function evidenceStats(rows: CoreLock[], target = 20) {
  const settled = rows.filter((r) => r.settledAt && r.hit != null);
  const wins = settled.filter((r) => r.hit).length;
  return {
    settled: settled.length,
    target,
    wins,
    winRate:
      settled.length === 0
        ? "—"
        : `${((wins / settled.length) * 100).toFixed(1)}%`,
  };
}

export function loadTrades(): PaperTrade[] {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(TRADE_KEY);
    return raw ? (JSON.parse(raw) as PaperTrade[]) : [];
  } catch {
    return [];
  }
}

export function saveTrades(rows: PaperTrade[]): void {
  if (!canUseStorage()) return;
  localStorage.setItem(TRADE_KEY, JSON.stringify(rows));
}

export function appendTrade(t: PaperTrade): PaperTrade[] {
  const rows = loadTrades();
  rows.push(t);
  saveTrades(rows);
  return rows;
}

export function settleTradesForWindow(
  windowId: string,
  endPx: number
): PaperTrade[] {
  const rows = loadTrades().map((t) =>
    t.windowId === windowId && !t.settledAt ? settlePaperTrade(t, endPx) : t
  );
  saveTrades(rows);
  return rows;
}

export function loadCustomRef(): number | null {
  if (!canUseStorage()) return null;
  const v = localStorage.getItem(CUSTOM_REF_KEY);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function saveCustomRef(n: number | null): void {
  if (!canUseStorage()) return;
  if (n == null) localStorage.removeItem(CUSTOM_REF_KEY);
  else localStorage.setItem(CUSTOM_REF_KEY, String(n));
}

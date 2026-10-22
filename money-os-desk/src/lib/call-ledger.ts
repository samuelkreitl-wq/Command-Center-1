/**
 * Append-only store for BTC15 call decisions.
 * Events are inserted and never rewritten. Settlement is its own event.
 */

import type {
  Agreement,
  DataQuality,
  Direction,
} from "./types";
import type { IndicatorName } from "./engine";

export const CALL_LEDGER_KEY = "moneyos.btc.callLedger.v1";

export type EvidenceRole = "SUPPORTS" | "CONFLICTS" | "NEUTRAL";
export type StrikeSource = "kalshi_floor_strike" | "unpublished";
export type PriceSource = "kraken_ticker" | "kraken_1m_close" | "none";
export type CallBasis = "trend_projection" | "last_vs_strike";

export interface EvidenceCitation {
  indicator: IndicatorName | "SPOT_VS_STRIKE";
  role: EvidenceRole;
  raw: Record<string, number | null>;
}

export interface QualityParts {
  quote: DataQuality;
  strike: DataQuality;
  clock: DataQuality;
  bars: DataQuality;
}

export interface CallDecision {
  call: Direction;
  at: number;
  basis: CallBasis;
  quality: DataQuality;
  qualityParts: QualityParts;
  agreement: Agreement;
  price: number | null;
  priceTs: number | null;
  priceSource: PriceSource;
  strike: number | null;
  strikeSource: StrikeSource;
  anchorNote: string;
  openTime: string;
  closeTime: string;
  barCount: number;
  lastClosedBarEndTs: number | null;
  evidence: EvidenceCitation[];
  why: string;
}

export interface CallRevision extends CallDecision {
  /** Relative to the locked initial call. */
  effect: "keep" | "flip";
  initialCall: Direction;
}

export interface SettlementRecord {
  at: number;
  endPx: number;
  strike: number;
  outcome: Direction;
  initialHit: boolean;
  finalHit: boolean;
}

export type LedgerEvent =
  | { type: "initial"; windowId: string; decision: CallDecision }
  | { type: "revision"; windowId: string; revision: CallRevision }
  | { type: "settlement"; windowId: string; settlement: SettlementRecord };

export interface WindowCallState {
  windowId: string;
  ticker: string;
  openTime: string;
  closeTime: string;
  initial: CallDecision;
  revision: CallRevision | null;
  finalCall: Direction;
  settlement: SettlementRecord | null;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function loadEvents(store: KeyValueStore, key: string): LedgerEvent[] {
  const raw = store.getItem(key);
  if (raw == null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BTC15 call ledger is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("BTC15 call ledger is not a list");
  return parsed as LedgerEvent[];
}

function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export class CallLedger {
  private events: LedgerEvent[];

  constructor(
    private store: KeyValueStore = new MemoryStore(),
    private key = CALL_LEDGER_KEY
  ) {
    this.events = loadEvents(store, key);
  }

  all(): readonly LedgerEvent[] {
    return this.events;
  }

  /** Push one event. Existing events are not edited. */
  append(event: LedgerEvent): void {
    const frozen = deepFreeze(structuredClone(event));
    this.events.push(frozen);
    this.store.setItem(this.key, JSON.stringify(this.events));
  }
}

export function createCallLedger(store?: KeyValueStore): CallLedger {
  if (store) return new CallLedger(store);
  if (typeof localStorage !== "undefined") return new CallLedger(localStorage);
  return new CallLedger(new MemoryStore());
}

export function windowCallId(
  ticker: string,
  openTime: string,
  closeTime: string
): string {
  return `${ticker}::${openTime}::${closeTime}`;
}

export function foldWindow(
  events: readonly LedgerEvent[],
  windowId: string,
  ticker: string
): WindowCallState | null {
  let initial: CallDecision | null = null;
  let revision: CallRevision | null = null;
  let settlement: SettlementRecord | null = null;
  let openTime = "";
  let closeTime = "";
  for (const event of events) {
    if (event.windowId !== windowId) continue;
    if (event.type === "initial" && !initial) {
      initial = event.decision;
      openTime = event.decision.openTime;
      closeTime = event.decision.closeTime;
    } else if (event.type === "revision" && !revision) {
      revision = event.revision;
    } else if (event.type === "settlement" && !settlement) {
      settlement = event.settlement;
    }
  }
  if (!initial) return null;
  return {
    windowId,
    ticker,
    openTime,
    closeTime,
    initial,
    revision,
    finalCall: revision ? revision.call : initial.call,
    settlement,
  };
}

export function findWindowCall(
  ledger: CallLedger,
  ticker: string,
  closeTime: string
): WindowCallState | null {
  for (const event of ledger.all()) {
    if (event.type !== "initial") continue;
    if (Date.parse(event.decision.closeTime) !== Date.parse(closeTime)) continue;
    const tickerFromId = event.windowId.split("::")[0];
    if (tickerFromId !== ticker) continue;
    return foldWindow(ledger.all(), event.windowId, ticker);
  }
  return null;
}

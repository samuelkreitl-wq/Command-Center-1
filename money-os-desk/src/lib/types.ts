/** Money OS — Kalshi short-window desk types (Phase 1+2) */

export type Direction = "UP" | "DOWN";
export type MarketWindow = "15m" | "5m";
export type SignalAction = "NO_TRADE" | "WATCH" | "LEAN_YES" | "LEAN_NO";
export type TradeMode = "paper" | "live";
export type TradeSide = "YES" | "NO";

export interface ContractWindow {
  ticker: string;
  series: string;
  market: MarketWindow;
  strike: number;
  closeTime: string; // ISO
  yesAsk: number; // 0–1
  noAsk: number; // 0–1
}

export interface SpotTick {
  price: number;
  ts: number;
  source: "kraken" | "proxy" | "manual";
}

export interface CoreLock {
  windowId: string; // ticker + closeTime
  ticker: string;
  market: MarketWindow;
  lockedCall: Direction;
  confidence: number;
  lockedAt: number;
  startPx: number;
  strike: number;
  closeTime: string;
  action: SignalAction;
  factors: string[];
  /** set only on settle — never rewrite call fields */
  settledAt?: number;
  outcome?: Direction;
  endPx?: number;
  hit?: boolean;
  postmortem?: string;
}

export interface ScalpState {
  windowId: string;
  lean: Direction | null;
  updatedAt: number;
}

export interface PaperTrade {
  id: string;
  windowId: string;
  ticker: string;
  market: MarketWindow;
  mode: TradeMode;
  side: TradeSide;
  size: number;
  entry: number; // ask used
  strike: number;
  openedAt: number;
  settledAt?: number;
  outcome?: Direction;
  endPx?: number;
  pnl?: number;
  note?: string;
}

export interface HardStopState {
  active: boolean;
  until?: number;
  reason: string;
  lastMissTicker?: string;
}

/** Crypto Fear & Greed (alternative.me) */
export interface FearGreedReading {
  value: number;
  classification: string;
  timestamp: number;
  timeUntilUpdate?: number;
}

export interface FearGreedSnapshot {
  current: FearGreedReading | null;
  yesterday?: FearGreedReading | null;
  lastWeek?: FearGreedReading | null;
  fetchedAt: number;
  error?: string;
}

export interface DeskSnapshot {
  contract: ContractWindow | null;
  spot: SpotTick | null;
  customRef: number | null;
  leanVsStrike: Direction | null;
  leanVsCustom: Direction | null;
  distanceToStrike: number | null;
  distanceToCustom: number | null;
  minutesLeft: number | null;
  liveCall: Direction | null;
  confidence: number;
  action: SignalAction;
  actionWhy: string;
  factors: string[];
  coreLock: CoreLock | null;
  scalp: ScalpState | null;
  hardStop: HardStopState;
  evidence: { settled: number; target: number; wins: number; winRate: string };
  fearGreed?: FearGreedSnapshot | null;
}

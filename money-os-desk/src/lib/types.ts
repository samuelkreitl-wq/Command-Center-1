/** Money OS — Kalshi short-window desk types (Phase 1+2) */

export type Direction = "UP" | "DOWN" | "AT STRIKE";
export type ExpectedStrikeSource = "posted-strike" | "open-market" | "prior-settle" | "spot";
export type MarketWindow = "15m" | "5m";
export type SignalAction = "NO_TRADE" | "WATCH" | "LEAN_YES" | "LEAN_NO";
export type TradeMode = "paper" | "live";
export type TradeSide = "YES" | "NO";

export interface ContractWindow {
  ticker: string;
  series: string;
  market: MarketWindow;
  /** Null until Kalshi publishes floor_strike. Never invent one here. */
  strike: number | null;
  closeTime: string; // ISO
  openTime?: string;
  yesAsk: number; // 0–1
  noAsk: number; // 0–1
}

export interface SpotTick {
  price: number;
  ts: number;
  source: "kraken" | "proxy" | "manual";
}

export interface CallRevision {
  at: number;
  from: Direction;
  to: Direction;
  reason: string;
}

export interface RevisionRefusal {
  at: number;
  attempted: Direction;
  reason: string;
}

export interface CoreLock {
  windowId: string; // ticker + closeTime
  ticker: string;
  market: MarketWindow;
  /** Null only when missed is true. A missed window has no call. */
  lockedCall: Direction | null;
  confidence: number;
  lockedAt: number;
  startPx: number;
  /** Reference the call was locked against (expected strike, or the posted strike). */
  strike: number;
  closeTime: string;
  openTime?: string;
  action: SignalAction;
  factors: string[];
  /** Kalshi floor_strike once it exists. Recording it does not change lockedCall. */
  officialStrike?: number;
  expectedStrikeSource?: ExpectedStrikeSource;
  /** Desk was not running before the open, so this window has no call. */
  missed?: boolean;
  /** The one allowed halfway change. lockedCall stays the original. */
  revisedCall?: Direction;
  revision?: CallRevision;
  /** A second change was refused. It is not cleared and cannot be approved later. */
  revisionRefusal?: RevisionRefusal;
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
}


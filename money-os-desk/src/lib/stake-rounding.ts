/**
 * Stake Rounding for Sports Arbitrage / Account Survival
 * Adapted for Money OS Desk (TypeScript)
 *
 * Provides human-looking stake sizes to reduce sportsbook detection
 * while keeping residual risk manageable.
 */

export type PlatformType = "soft" | "sharp" | "exchange";

export interface RoundingConfig {
  softJitterPct: number;
  sharpJitterPct: number;
  exchangeJitterPct: number;
  forceRoundOnSoft: boolean;
  forceRoundOnSharp: boolean;
  forceRoundOnExchange: boolean;
  minStake: number;
  softIncrements: Record<string, number>;
  sharpIncrements: Record<string, number>;
  thresholds: Record<string, number>;
}

export const DEFAULT_CONFIG: RoundingConfig = {
  softJitterPct: 0.09,
  sharpJitterPct: 0.03,
  exchangeJitterPct: 0.02,
  forceRoundOnSoft: true,
  forceRoundOnSharp: false,
  forceRoundOnExchange: false,
  minStake: 1.0,
  softIncrements: { tiny: 5, small: 10, medium: 25, large: 50, xlarge: 100 },
  sharpIncrements: { tiny: 1, small: 5, medium: 10, large: 10, xlarge: 25 },
  thresholds: { tiny: 30, small: 100, medium: 300, large: 1000 },
};

export interface RoundedStake {
  original: number;
  rounded: number;
  jitterApplied: number;
  platform: PlatformType;
  incrementUsed: number;
}

export interface ArbResult {
  stakes: RoundedStake[];
  totalStaked: number;
  outcomes: number[];
  minProfit: number;
  maxProfit: number;
  residualRisk: number;
}

function roundToNearest(value: number, increment: number): number {
  if (increment <= 0) return value;
  return Math.round(value / increment) * increment;
}

function applyJitter(value: number, jitterPct: number): number {
  if (jitterPct <= 0 || value <= 0) return value;
  const factor = 1 + (Math.random() * 2 - 1) * jitterPct;
  return value * factor;
}

function getIncrement(stake: number, platform: PlatformType, config: RoundingConfig): number {
  const table = platform === "soft" ? config.softIncrements : config.sharpIncrements;
  const t = config.thresholds;
  if (stake < t.tiny) return table.tiny;
  if (stake < t.small) return table.small;
  if (stake < t.medium) return table.medium;
  if (stake < t.large) return table.large;
  return table.xlarge;
}

function getJitter(platform: PlatformType, config: RoundingConfig): number {
  switch (platform) {
    case "soft": return config.softJitterPct;
    case "sharp": return config.sharpJitterPct;
    default: return config.exchangeJitterPct;
  }
}

function shouldForceRound(platform: PlatformType, config: RoundingConfig): boolean {
  switch (platform) {
    case "soft": return config.forceRoundOnSoft;
    case "sharp": return config.forceRoundOnSharp;
    default: return config.forceRoundOnExchange;
  }
}

export function roundStake(
  idealStake: number,
  platform: PlatformType = "soft",
  config: RoundingConfig = DEFAULT_CONFIG
): RoundedStake {
  if (idealStake <= 0) {
    return { original: 0, rounded: 0, jitterApplied: 0, platform, incrementUsed: 0 };
  }

  const jitterPct = getJitter(platform, config);
  const jittered = applyJitter(idealStake, jitterPct);
  const force = shouldForceRound(platform, config);
  const increment = getIncrement(jittered, platform, config);

  let rounded = force ? roundToNearest(jittered, increment) : Math.round(jittered * 100) / 100;

  if (rounded < config.minStake && idealStake >= config.minStake) {
    rounded = Math.max(config.minStake, increment);
  }

  return {
    original: idealStake,
    rounded,
    jitterApplied: jittered - idealStake,
    platform,
    incrementUsed: force ? increment : 0,
  };
}

export function balanceTwoWayArb(
  oddsA: number,
  oddsB: number,
  totalBankroll: number,
  platformA: PlatformType = "soft",
  platformB: PlatformType = "soft",
  config: RoundingConfig = DEFAULT_CONFIG
): ArbResult {
  const invA = 1 / oddsA;
  const invB = 1 / oddsB;
  const totalInv = invA + invB;

  const idealA = totalBankroll * (invA / totalInv);
  const idealB = totalBankroll * (invB / totalInv);

  const stakeA = roundStake(idealA, platformA, config);
  const stakeB = roundStake(idealB, platformB, config);

  const totalStaked = stakeA.rounded + stakeB.rounded;
  const returnA = stakeA.rounded * oddsA;
  const returnB = stakeB.rounded * oddsB;

  const profitA = returnA - totalStaked;
  const profitB = returnB - totalStaked;

  return {
    stakes: [stakeA, stakeB],
    totalStaked,
    outcomes: [returnA, returnB],
    minProfit: Math.min(profitA, profitB),
    maxProfit: Math.max(profitA, profitB),
    residualRisk: Math.abs(profitA - profitB) / 2,
  };
}

// Example usage:
// const result = balanceTwoWayArb(2.45, 1.74, 1000, "soft", "soft");
// console.log(result);

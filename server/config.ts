export type DeskMode = "paper" | "live" | "both";

export type DeskConfig = {
  mode: DeskMode;
  tradingEnabled: boolean;
  kalshiEnv: "demo" | "prod";
  maxContracts: number;
  maxCost: number;
  tolerance: number;
  ttlMs: number;
  paperPollMs: number;
  horizonRefreshMs: number;
  testReset: boolean;
};

export function readConfig(env: Record<string, string | undefined> = process.env): DeskConfig {
  const raw = (env.MODE || env.DESK_MODE || "paper").toLowerCase();
  const mode: DeskMode = raw === "live" || raw === "both" ? raw : "paper";
  return {
    mode,
    tradingEnabled: /^(1|true|yes)$/i.test(env.TRADING_ENABLED || ""),
    kalshiEnv: (env.KALSHI_ENV || "demo").toLowerCase() === "prod" ? "prod" : "demo",
    maxContracts: positive(env.MAX_CONTRACTS, 10),
    maxCost: positive(env.MAX_ORDER_COST, 10),
    tolerance: positive(env.PRICE_MOVE_TOLERANCE, 0.02),
    ttlMs: positive(env.PROPOSAL_TTL_MS, 60_000),
    paperPollMs: positive(env.PAPER_POLL_MS, 20_000),
    horizonRefreshMs: positive(env.SHORT_HORIZON_REFRESH_MS, 60 * 60 * 1000),
    testReset: env.DESK_TEST_RESET === "1",
  };
}

function positive(value: string | undefined, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

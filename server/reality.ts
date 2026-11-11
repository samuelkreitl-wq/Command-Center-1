import type { DeskRecord } from "./store.js";

export type RealityInput = {
  rulesRead: boolean;
  rulesMatchModel: boolean;
  stale: boolean;
  timestampsPresent: boolean;
  depth: number | null;
  plannedContracts: number;
  spread: number | null;
  bookSeenTwice: boolean;
  overlapsOpen: boolean;
  variants: number;
  worstEdgeCents: number;
  onlyOneVariantPositive: boolean;
  feesIncluded: boolean;
  edgeSurvivesFees: boolean;
  lossScenario: string;
  closesWithinMinutes: number | null;
  cashKnown: boolean;
  cashDisclosedIfUnknown: boolean;
  noModel: boolean;
  thresholdClears: boolean;
};

export type RealityResult = {
  verdict: "PASS" | "WATCH" | "FAIL";
  failed: string[];
  reasons: string[];
  watch_trigger?: string;
};

const QUESTIONS: Array<{ id: string; ask: string; fail: (input: RealityInput) => boolean; watch?: (input: RealityInput) => boolean }> = [
  { id: "settlement", ask: "Settlement source and rules were read and match the model.", fail: (i) => !i.rulesRead || !i.rulesMatchModel },
  { id: "freshness", ask: "Every input has a timestamp and is inside the freshness window.", fail: (i) => !i.timestampsPresent || i.stale },
  {
    id: "liquidity",
    ask: "Depth covers the planned size and the spread is 3 cents or less.",
    fail: (i) => i.depth == null || i.depth + 1e-9 < Math.max(1, i.plannedContracts) || (i.spread != null && i.spread > 0.05),
    watch: (i) => !i.bookSeenTwice || (i.spread != null && i.spread > 0.03),
  },
  { id: "correlation", ask: "This does not double an open position.", fail: (i) => i.overlapsOpen },
  {
    id: "model",
    ask: "Worst-case edge is positive across model variants.",
    fail: (i) => i.noModel || i.variants < 1 || !(i.worstEdgeCents > 0),
    watch: (i) => i.onlyOneVariantPositive || i.variants < 2,
  },
  { id: "fees", ask: "Fees are in at the planned size.", fail: (i) => !i.feesIncluded || !i.edgeSurvivesFees },
  { id: "wrong", ask: "The loss scenario is named.", fail: (i) => !i.lossScenario.trim() },
  { id: "base", ask: "The fair probability is a model, not a claim that a longshot is certain.", fail: () => false },
  { id: "news", ask: "No separate news feed is priced. That limit is disclosed.", fail: () => false },
  { id: "time", ask: "There is time to confirm and fill.", fail: (i) => i.closesWithinMinutes != null && i.closesWithinMinutes < 5 },
  { id: "cash", ask: "Shard cash is known, or the gap is stated.", fail: (i) => !i.cashKnown && !i.cashDisclosedIfUnknown },
  { id: "rules", ask: "No auto-bet. Official strike only. A 15-minute window is named by its end.", fail: () => false },
];

export function runRealityCheck(input: RealityInput): RealityResult {
  const failed: string[] = [];
  const watched: string[] = [];
  const reasons: string[] = [];
  for (const question of QUESTIONS) {
    if (question.fail(input)) {
      failed.push(question.id);
      reasons.push(`FAIL ${question.id}: ${question.ask}`);
    } else if (question.watch?.(input)) {
      watched.push(question.id);
      reasons.push(`WATCH ${question.id}: ${question.ask}`);
    } else {
      reasons.push(`OK ${question.id}: ${question.ask}`);
    }
  }
  if (input.noModel) {
    return {
      verdict: failed.length ? "FAIL" : "WATCH",
      failed,
      reasons: [...reasons, "no model"],
      watch_trigger: "A fair-value source is connected for this tab",
    };
  }
  if (failed.length) return { verdict: "FAIL", failed, reasons };
  if (!input.thresholdClears || watched.length) {
    return {
      verdict: "WATCH",
      failed,
      reasons,
      watch_trigger: !input.thresholdClears
        ? "Worst-case edge clears 2 cents and 3% of price, with depth"
        : `Recheck ${watched.join(", ")}`,
    };
  }
  return { verdict: "PASS", failed, reasons };
}

export function realityForRecord(record: DeskRecord): RealityResult {
  const cents = record.edge.cents_per_contract_after_fees;
  const price = record.price;
  const noModel = record.model === "no model" || record.fair_prob == null;
  const closes = record.market.close_time_et ? (Date.parse(record.market.close_time_et) - Date.now()) / 60000 : null;
  return runRealityCheck({
    rulesRead: (record.reasons || []).some((r) => r.toLowerCase().includes("rules")),
    rulesMatchModel: !noModel || record.model === "no model",
    stale: false,
    timestampsPresent: Object.keys(record.data_timestamps || {}).length > 0,
    depth: record.depth ?? null,
    plannedContracts: Math.max(1, record.stake_suggestion.contracts || 1),
    spread: record.spread ?? null,
    bookSeenTwice: (record.reasons || []).some((r) => r.toLowerCase().includes("book seen")),
    overlapsOpen: false,
    variants: record.fair_prob_range ? 2 : record.fair_prob == null ? 0 : 1,
    worstEdgeCents: cents,
    onlyOneVariantPositive: false,
    feesIncluded: record.edge.fee_dollars != null,
    edgeSurvivesFees: cents >= 2,
    lossScenario: record.summary?.[2] || "",
    closesWithinMinutes: closes,
    cashKnown: false,
    cashDisclosedIfUnknown: (record.unverified || []).some((u) => /cash|bankroll|shard/i.test(u)),
    noModel,
    thresholdClears: cents >= 2 && price > 0 && cents / 100 >= 0.03 * price,
  });
}

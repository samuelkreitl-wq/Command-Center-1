/**
 * Example usage of stake-rounding module
 */
import { balanceTwoWayArb, DEFAULT_CONFIG } from "./stake-rounding";

const result = balanceTwoWayArb(2.45, 1.74, 1000);

console.log("Stake Rounding Example");
console.log("----------------------");
result.stakes.forEach((s, i) => {
  console.log(`Side ${i + 1}: $${s.original.toFixed(2)} → $${s.rounded.toFixed(0)} (${s.platform})`);
});
console.log(`Total staked: $${result.totalStaked.toFixed(0)}`);
console.log(`Profit range: $${result.minProfit.toFixed(2)} → $${result.maxProfit.toFixed(2)}`);
console.log(`Residual risk: $${result.residualRisk.toFixed(2)}`);

import { runScan } from "./scan.js";

const report = await runScan();
const brief = {
  finishedAt: report.finishedAt,
  pass: report.pass.map((pick) => ({
    ticker: pick.market.ticker,
    side: pick.side,
    price: pick.price,
    edge: pick.edge.cents_per_contract_after_fees,
    fair: pick.fair_prob,
    source: pick.fair_prob_source,
    proxy: pick.proxy_label,
  })),
  watch: report.watch.length,
  saved: report.saved.length,
  failCount: report.failCount,
  coverage: report.coverage,
  errors: report.errors,
  timestamps: report.timestamps,
};
console.log(JSON.stringify(brief, null, 2));
if (report.errors.some((error) => /series|kalshi/i.test(error)) && report.coverage.length === 0) {
  process.exitCode = 1;
}

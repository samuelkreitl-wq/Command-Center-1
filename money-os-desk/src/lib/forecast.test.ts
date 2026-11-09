import { test } from "node:test";
import assert from "node:assert/strict";
import { bandWidth, forecastToClose, scenarioIsStale, shortHorizonScenario, shouldRefresh, DEFAULT_SHORT_HORIZON_REFRESH_MS } from "./forecast";

function wavy(n = 48): number[] {
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * Math.exp(i % 2 ? 0.002 : -0.001));
  return closes;
}

test("15-minute bands widen as minutes remaining grow", () => {
  const minuteCloses = wavy();
  const near = forecastToClose({ spot: 100, minuteCloses, minutesRemaining: 4, strike: 100, longBias: "FLAT" });
  const far = forecastToClose({ spot: 100, minuteCloses, minutesRemaining: 64, strike: 100, longBias: "FLAT" });
  assert.equal(near.ok && far.ok, true);
  if (near.ok && far.ok) assert.ok(bandWidth(far.band90) > bandWidth(near.band90));
});

test("probability of finishing above the strike falls as the strike rises", () => {
  const minuteCloses = wavy();
  const probs = [90, 100, 110].map((strike) => {
    const forecast = forecastToClose({ spot: 100, minuteCloses, minutesRemaining: 30, strike, longBias: "FLAT" });
    assert.equal(forecast.ok, true);
    return forecast.ok ? forecast.probabilityAbove ?? 0 : 0;
  });
  assert.ok(probs[0] > probs[1] && probs[1] > probs[2]);
});

test("a capped long nudge cannot flip a strike that sits further than the cap", () => {
  const minuteCloses: number[] = [100];
  for (let i = 0; i < 40; i++) minuteCloses.push(minuteCloses[i] * Math.exp(i % 2 ? 0.001 : -0.001));
  const flat = forecastToClose({ spot: 100, minuteCloses, minutesRemaining: 15, strike: 100, longBias: "FLAT", projectionSigma: 0 });
  assert.equal(flat.ok, true);
  if (!flat.ok) return;
  const sigma = flat.sigma;
  const strike = 100 * Math.exp(0.6 * sigma + 0.25 * sigma);
  const pushed = forecastToClose({ spot: 100, minuteCloses, minutesRemaining: 15, strike, longBias: "UPHILL", projectionSigma: 50 });
  assert.equal(pushed.ok, true);
  if (!pushed.ok) return;
  assert.ok(Math.abs(pushed.nudge) <= 0.25 * pushed.sigma + 1e-9);
  assert.ok((pushed.probabilityAbove ?? 1) < 0.5);
});

test("short-horizon bands scale with sqrt(days) and the scheduler waits an hour", () => {
  const daily = wavy(40).map((value, i) => 70_000 * (1 + i / 400) * (value / 100));
  const scenario = shortHorizonScenario({ spot: 74530, dailyCloses: daily, longBias: "FLAT" });
  assert.equal(scenario.ok, true);
  if (!scenario.ok) return;
  const w1 = bandWidth(scenario.horizons["1d"].band90);
  const w3 = bandWidth(scenario.horizons["3d"].band90);
  const w7 = bandWidth(scenario.horizons["7d"].band90);
  assert.ok(w7 > w3 && w3 > w1);
  assert.equal(scenario.horizons["3d"].days, 3);
  assert.equal(shouldRefresh(1_000, 1_000 + DEFAULT_SHORT_HORIZON_REFRESH_MS - 1), false);
  assert.equal(shouldRefresh(1_000, 1_000 + DEFAULT_SHORT_HORIZON_REFRESH_MS), true);
  assert.equal(shouldRefresh(1_000, 1_001, DEFAULT_SHORT_HORIZON_REFRESH_MS, true), true);
  assert.equal(scenarioIsStale(1_000, 1_000 + DEFAULT_SHORT_HORIZON_REFRESH_MS * 2 + 1), true);
});

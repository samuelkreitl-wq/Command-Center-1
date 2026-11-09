import { test } from "node:test";
import assert from "node:assert/strict";
import { findCrossings, projectForward, projectionDrift, PROJECTION_SIGMA_CAP } from "./projection";

test("a known log-linear trend extends at the fitted slope and the band widens", () => {
  const closes = Array.from({ length: 12 }, (_, i) => 100 * Math.exp(0.01 * i));
  const projected = projectForward(closes, 86_400_000, 5, 0);
  const last = closes[closes.length - 1];
  assert.ok(Math.abs(projected.points[5].price - last * Math.exp(0.01 * 5)) < 1e-6);
  assert.equal(projected.kind, "SCENARIO");
  const noisy = [100];
  for (let i = 1; i < 30; i++) noisy.push(noisy[i - 1] * Math.exp(0.001 + (i % 2 ? 0.01 : -0.008)));
  const banded = projectForward(noisy, 60_000, 20, 0);
  const width = (step: number) => banded.points[step].high90 - banded.points[step].low90;
  assert.ok(width(20) > width(4));
  assert.ok(width(4) > width(0));
});

test("crossing detection interpolates the projected path", () => {
  const path = [
    { t: 0, price: 100, low: 100, high: 100 },
    { t: 10, price: 110, low: 110, high: 110 },
    { t: 20, price: 130, low: 130, high: 130 },
  ];
  const hits = findCrossings(path, [{ price: 120, label: "120", source: "round" }]).filter((hit) => hit.kind === "path");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].projectedTime, 15);
});

test("projection weight is capped and the minute tape weight is zero", () => {
  const result = projectionDrift({
    sigma: 0.02,
    weights: { "6M": 100 },
    frames: [
      { id: "6M", direction: "UPHILL" },
      { id: "M", direction: "DOWNHILL" },
    ],
  });
  assert.ok(result.raw > result.cap);
  assert.equal(result.applied, PROJECTION_SIGMA_CAP * 0.02);
  assert.equal(result.contributions.find((item) => item.id === "M")?.weight, 0);
});

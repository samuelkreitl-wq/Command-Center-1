import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSafety } from "./safety-net";

const calm = { pointReturn: 0.01, lower90Return: -0.02, pDrop10: 0.05, longBias: "UPHILL" as const, shortTape: "UPHILL" as const, acceleration: 0 };

test("each safety trigger fires and clears", () => {
  assert.equal(evaluateSafety(calm).level, "none");
  assert.equal(evaluateSafety({ ...calm, pointReturn: -0.08 }).level, "danger");
  assert.equal(evaluateSafety({ ...calm, pointReturn: -0.05 }).level, "watch");
  assert.equal(evaluateSafety({ ...calm, pointReturn: -0.03 }).level, "none");
  assert.equal(evaluateSafety({ ...calm, lower90Return: -0.16 }).level, "danger");
  assert.equal(evaluateSafety({ ...calm, lower90Return: -0.11 }).level, "watch");
  assert.equal(evaluateSafety({ ...calm, lower90Return: -0.05 }).level, "none");
  assert.equal(evaluateSafety({ ...calm, pDrop10: 0.30 }).level, "danger");
  assert.equal(evaluateSafety({ ...calm, pDrop10: 0.16 }).level, "watch");
  assert.equal(evaluateSafety({ ...calm, pDrop10: 0.10 }).level, "none");
  assert.equal(evaluateSafety({ ...calm, longBias: "DOWNHILL", shortTape: "DOWNHILL", acceleration: -0.001 }).level, "danger");
  assert.equal(evaluateSafety({ ...calm, longBias: "DOWNHILL", shortTape: "DOWNHILL", acceleration: 0 }).level, "watch");
  assert.equal(evaluateSafety({ ...calm, longBias: "DOWNHILL", shortTape: "UPHILL", acceleration: -0.001 }).level, "none");
});

test("danger outranks watch when both are present", () => {
  const result = evaluateSafety({ ...calm, pointReturn: -0.05, pDrop10: 0.4 });
  assert.equal(result.level, "danger");
  assert.ok(result.active.some((item) => item.id === "point" && item.level === "watch"));
  assert.ok(result.active.some((item) => item.id === "p10" && item.level === "danger"));
});

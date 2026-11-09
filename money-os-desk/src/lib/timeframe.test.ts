import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisPath, classifyCloses, evaluateTimeframes, longBias, shortTape } from "./timeframe";

function trend(dir: 1 | -1, n = 40): number[] {
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (dir > 0 ? 1.01 : 0.99));
  return closes;
}

test("classification marks a rising series UPHILL and a falling series DOWNHILL", () => {
  assert.equal(classifyCloses(trend(1)).direction, "UPHILL");
  assert.equal(classifyCloses(trend(-1)).direction, "DOWNHILL");
  assert.equal(classifyCloses(Array.from({ length: 12 }, () => 100)).direction, "FLAT");
});

test("long cache is kept inside its refresh and recomputed after it", async () => {
  const calls: string[] = [];
  const load = async (id: string) => {
    calls.push(id);
    return { closes: trend(1) };
  };
  const first = await evaluateTimeframes({ now: 0, cache: {}, load });
  const six = calls.filter((id) => id === "6M").length;
  const minutes = calls.filter((id) => id === "M").length;
  const second = await evaluateTimeframes({ now: 60_000, cache: first.cache, load });
  assert.equal(calls.filter((id) => id === "6M").length, six);
  assert.ok(calls.filter((id) => id === "M").length > minutes);
  await evaluateTimeframes({ now: 24 * 60 * 60 * 1000 + 1, cache: second.cache, load });
  assert.ok(calls.filter((id) => id === "6M").length > six);
});

test("conflict runs the deep read and an aligned tape skips it", async () => {
  let deepCalls = 0;
  const deep = () => {
    deepCalls += 1;
    return { notes: ["deep"], acceleration: -1, volRegime: "steady" as const, reversal: false, distanceSigma: null };
  };
  const aligned = await evaluateTimeframes({
    now: 0,
    cache: {},
    load: async () => ({ closes: trend(1) }),
    deep,
  });
  assert.equal(aligned.path, "aligned");
  assert.equal(deepCalls, 0);
  assert.equal(aligned.deep, null);
  deepCalls = 0;
  const conflict = await evaluateTimeframes({
    now: 0,
    cache: {},
    load: async (id) => ({ closes: id === "1H" || id === "M" ? trend(-1) : trend(1) }),
    deep,
  });
  assert.equal(conflict.path, "conflict");
  assert.equal(deepCalls, 1);
  assert.equal(longBias(conflict.frames), "UPHILL");
  assert.equal(shortTape(conflict.frames), "DOWNHILL");
  assert.equal(analysisPath("UPHILL", "DOWNHILL"), "conflict");
  assert.equal(analysisPath("UPHILL", "UPHILL"), "aligned");
  assert.equal(analysisPath("FLAT", "DOWNHILL"), "aligned");
});

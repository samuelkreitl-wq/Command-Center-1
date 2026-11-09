import { test } from "node:test";
import assert from "node:assert/strict";
import { createResilientLoop } from "./loop";

test("a throwing tick is caught and the loop schedules another run", async () => {
  const timers: Array<() => void> = [];
  let runs = 0;
  const errors: unknown[] = [];
  const loop = createResilientLoop({
    intervalMs: 20,
    setTimer: (fn) => { timers.push(fn); return 0; },
    onError: (error) => errors.push(error),
    tick: async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom");
    },
  });
  await loop.start();
  assert.equal(runs, 1);
  assert.equal(errors.length, 1);
  assert.equal(timers.length, 1);
  timers[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs, 2);
  assert.equal(loop.beats, 1);
  loop.stop();
});

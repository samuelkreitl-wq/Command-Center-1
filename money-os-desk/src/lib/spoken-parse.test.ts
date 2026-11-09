import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHorizonQuestion, parseUtterance } from "./spoken-parse";

test("seventy-four four hundred at 1:15 parses 74400 and the close", () => {
  const parsed = parseUtterance("seventy-four four hundred, 1:15");
  assert.equal(parsed.price, 74400);
  assert.equal(parsed.time?.hour, 1);
  assert.equal(parsed.time?.minute, 15);
  assert.equal(parsed.time?.ampm, undefined);
  assert.deepEqual(parsed.errors, []);
});

test("74400 1:15 keeps a full price", () => {
  const parsed = parseUtterance("74400 1:15");
  assert.equal(parsed.price, 74400);
  assert.equal(parsed.time?.minute, 15);
});

test("743 at 1:15 is 74300", () => {
  const parsed = parseUtterance("743 at 1:15");
  assert.equal(parsed.price, 74300);
  assert.equal(parsed.time?.raw.includes("1:15"), true);
});

test("74.4k with pm", () => {
  const parsed = parseUtterance("74.4k 1:15pm");
  assert.equal(parsed.price, 74400);
  assert.equal(parsed.time?.ampm, "pm");
});

test("stated side is kept", () => {
  const parsed = parseUtterance("down 74400 1:30");
  assert.equal(parsed.side, "no");
  assert.equal(parsed.price, 74400);
});

test("horizon questions", () => {
  assert.equal(parseHorizonQuestion("what's Bitcoin in 3 days?"), "3d");
  assert.equal(parseHorizonQuestion("what is bitcoin in 1 day"), "1d");
  assert.equal(parseHorizonQuestion("what's Bitcoin in 7 days"), "7d");
  assert.equal(parseHorizonQuestion("what's Bitcoin in a week?"), "7d");
  assert.equal(parseHorizonQuestion("74400 1:15"), null);
});

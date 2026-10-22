import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CallLedger, MemoryStore, foldWindow } from "./call-ledger";
import {
  LOCK_LEAD_MS,
  LOOP_BACKOFF_CAP_MS,
  LOOP_TICK_MS,
  MISSED_LOOKBACK_MS,
  advanceBtc15Calls,
  CallLifecycleError,
  formatActionLine,
  nextTickDelay,
  reviseAtHalfway,
  type Btc15CallInput,
} from "./call-lifecycle";
import { openJsonlLedger, readJsonlEvents } from "./jsonl-ledger";
import { HALFWAY_MS } from "./strike-call";

const OPEN = Date.parse("2026-10-22T18:45:00.000Z");
const WINDOW_MS = 15 * 60 * 1000;

function book(): CallLedger {
  return new CallLedger(new MemoryStore());
}

function windowInput(
  open: number,
  now: number,
  ticker: string,
  patch: Partial<Btc15CallInput> = {}
): Btc15CallInput {
  return {
    ticker,
    openTime: new Date(open).toISOString(),
    closeTime: new Date(open + WINDOW_MS).toISOString(),
    floorStrike: null,
    spot: null,
    bars: [],
    now,
    ...patch,
  };
}

function jsonlPath(): string {
  return join(mkdtempSync(join(tmpdir(), "btc15-ledger-")), "calls.jsonl");
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("next-window-only locking", () => {
  it("locks only the soonest future window inside the lead", () => {
    const now = OPEN - 90_000;
    const ledger = book();
    const inputs = [
      windowInput(OPEN, now, "KXBTC15M-A"),
      windowInput(OPEN + WINDOW_MS, now, "KXBTC15M-B"),
      windowInput(OPEN + 2 * WINDOW_MS, now, "KXBTC15M-C"),
    ];
    const actions = advanceBtc15Calls(ledger, inputs);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, "lock");
    assert.equal(actions[0].ticker, "KXBTC15M-A");
    const initials = ledger.all().filter((event) => event.type === "initial");
    assert.equal(initials.length, 1);
    assert.equal(initials[0].windowId.startsWith("KXBTC15M-A::"), true);
    assert.equal(actions[0].quality === "LIVE", false);

    const again = advanceBtc15Calls(ledger, inputs);
    assert.equal(again.filter((action) => action.kind === "lock").length, 0);
    assert.equal(ledger.all().filter((event) => event.type === "initial").length, 1);
  });

  it("does not lock the next window when it is still more than 120s away", () => {
    const ledger = book();
    const actions = advanceBtc15Calls(ledger, [
      windowInput(OPEN, OPEN - 180_000, "KXBTC15M-A"),
      windowInput(OPEN + WINDOW_MS, OPEN - 180_000, "KXBTC15M-B"),
    ]);
    assert.deepEqual(actions, []);
    assert.equal(ledger.all().length, 0);
  });

  it("locks at exactly 120s before open and not one millisecond earlier", () => {
    const onEdge = book();
    const locked = advanceBtc15Calls(onEdge, [
      windowInput(OPEN, OPEN - LOCK_LEAD_MS, "KXBTC15M-A"),
    ]);
    assert.equal(locked.length, 1);
    assert.equal(locked[0].kind, "lock");

    const tooEarly = book();
    const skipped = advanceBtc15Calls(tooEarly, [
      windowInput(OPEN, OPEN - LOCK_LEAD_MS - 1, "KXBTC15M-A"),
    ]);
    assert.deepEqual(skipped, []);
    assert.equal(tooEarly.all().length, 0);
  });
});

describe("restart reload", () => {
  it("reloads locks from the append-only file and still revises at halfway", () => {
    const path = jsonlPath();
    const first = openJsonlLedger(path);
    const locked = advanceBtc15Calls(first, [
      windowInput(OPEN, OPEN - 30_000, "KXBTC15M-A"),
    ]);
    assert.equal(locked[0].kind, "lock");
    const afterLock = readFileSync(path, "utf8");
    const firstLine = lines(afterLock)[0];

    const restarted = openJsonlLedger(path);
    assert.equal(restarted.all().length, 1);
    assert.equal(restarted.all()[0].type, "initial");
    const halfway = OPEN + HALFWAY_MS;
    const revised = advanceBtc15Calls(restarted, [
      windowInput(OPEN, halfway, "KXBTC15M-A", {
        floorStrike: 100,
        spot: { price: 140, ts: halfway, source: "kraken" },
      }),
    ]);
    assert.equal(revised.length, 1);
    assert.equal(revised[0].kind, "revision");
    if (revised[0].kind !== "revision") return;
    assert.equal(revised[0].effect, "flip");
    assert.equal(revised[0].initialCall, "AT STRIKE");
    assert.equal(revised[0].call, "UP");

    const afterRevise = readFileSync(path, "utf8");
    assert.equal(lines(afterRevise)[0], firstLine);
    assert.equal(afterRevise.startsWith(`${firstLine}\n`), true);
    assert.equal(readJsonlEvents(afterRevise).length, 2);
    const revision = restarted.all().find((event) => event.type === "revision");
    assert.ok(revision && revision.type === "revision");
    assert.match(revision.revision.why, /Flipped/);
  });

  it("ignores a truncated trailing line and rejects a corrupt earlier line", () => {
    const path = jsonlPath();
    const ledger = openJsonlLedger(path);
    advanceBtc15Calls(ledger, [windowInput(OPEN, OPEN - 30_000, "KXBTC15M-A")]);
    const firstLine = lines(readFileSync(path, "utf8"))[0];
    const events = readJsonlEvents(`${firstLine}\n{"type":"initial"`);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "initial");
    assert.throws(() => readJsonlEvents(`${firstLine}\n{bad\n{"type":"missed"}\n`));
  });
});

describe("missed windows", () => {
  it("records a miss instead of a retroactive lock and does not repeat it", () => {
    const ledger = book();
    const opened = windowInput(OPEN, OPEN + 1_000, "KXBTC15M-A");
    const actions = advanceBtc15Calls(ledger, [opened]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, "missed");
    assert.equal(formatActionLine(actions[0]), `${new Date(OPEN + 1_000).toISOString()} MISSED KXBTC15M-A no pre-start lock`);
    assert.equal(ledger.all().some((event) => event.type === "initial"), false);
    const missed = ledger.all()[0];
    assert.equal(missed.type, "missed");
    assert.match(missed.missed.reason, /no call was invented/);
    assert.equal(foldWindow(ledger.all(), missed.windowId, "KXBTC15M-A"), null);

    const again = advanceBtc15Calls(ledger, [
      windowInput(OPEN, OPEN + 2_000, "KXBTC15M-A"),
    ]);
    assert.deepEqual(again, []);
    assert.equal(ledger.all().length, 1);

    const halfway = OPEN + HALFWAY_MS;
    const atCheckpoint = advanceBtc15Calls(ledger, [
      windowInput(OPEN, halfway, "KXBTC15M-A", {
        floorStrike: 100,
        spot: { price: 140, ts: halfway, source: "kraken" },
      }),
    ]);
    assert.deepEqual(atCheckpoint, []);
    assert.throws(
      () =>
        reviseAtHalfway(
          ledger,
          windowInput(OPEN, halfway, "KXBTC15M-A", {
            floorStrike: 100,
            spot: { price: 140, ts: halfway, source: "kraken" },
          })
        ),
      (error: unknown) =>
        error instanceof CallLifecycleError && error.code === "UNKNOWN_WINDOW"
    );
  });

  it("does not mark a window missed once it is outside the lookback", () => {
    const ledger = book();
    const close = OPEN + WINDOW_MS;
    const actions = advanceBtc15Calls(ledger, [
      windowInput(OPEN, close + MISSED_LOOKBACK_MS, "KXBTC15M-OLD"),
    ]);
    assert.deepEqual(actions, []);
    assert.equal(ledger.all().length, 0);
  });
});

describe("single revision", () => {
  it("saves one keep-or-flip and does not write a second", () => {
    const ledger = book();
    advanceBtc15Calls(ledger, [windowInput(OPEN, OPEN - 10_000, "KXBTC15M-A")]);
    const halfway = OPEN + HALFWAY_MS;
    const flipped = advanceBtc15Calls(ledger, [
      windowInput(OPEN, halfway, "KXBTC15M-A", {
        floorStrike: 100,
        spot: { price: 140, ts: halfway, source: "kraken" },
      }),
    ]);
    assert.equal(flipped.length, 1);
    assert.equal(flipped[0].kind, "revision");
    if (flipped[0].kind !== "revision") return;
    assert.equal(flipped[0].effect, "flip");
    assert.match(formatActionLine(flipped[0]), / REVISE KXBTC15M-A FLIP AT STRIKE -> UP /);

    const keptBook = book();
    advanceBtc15Calls(keptBook, [windowInput(OPEN, OPEN - 10_000, "KXBTC15M-A")]);
    const kept = advanceBtc15Calls(keptBook, [
      windowInput(OPEN, halfway, "KXBTC15M-A", {
        floorStrike: 100,
        spot: { price: 100.01, ts: halfway, source: "kraken" },
      }),
    ]);
    assert.equal(kept[0].kind, "revision");
    if (kept[0].kind !== "revision") return;
    assert.equal(kept[0].effect, "keep");
    assert.equal(kept[0].call, "AT STRIKE");
    const keptEvent = keptBook.all().find((event) => event.type === "revision");
    assert.ok(keptEvent && keptEvent.type === "revision");
    assert.match(keptEvent.revision.why, /Kept/);

    const second = advanceBtc15Calls(ledger, [
      windowInput(OPEN, halfway + 1_000, "KXBTC15M-A", {
        floorStrike: 100,
        spot: { price: 50, ts: halfway, source: "kraken" },
      }),
    ]);
    assert.equal(second.filter((action) => action.kind === "revision").length, 0);
    assert.equal(ledger.all().filter((event) => event.type === "revision").length, 1);

    const after = advanceBtc15Calls(ledger, [
      windowInput(OPEN, halfway + 60_000, "KXBTC15M-A", {
        floorStrike: 100,
        spot: { price: 50, ts: halfway, source: "kraken" },
      }),
    ]);
    assert.deepEqual(after, []);
    assert.equal(ledger.all().length, 2);
  });
});

describe("settlement append", () => {
  it("appends settlement without rewriting the lock and does not settle twice", () => {
    const path = jsonlPath();
    const ledger = openJsonlLedger(path);
    advanceBtc15Calls(ledger, [windowInput(OPEN, OPEN - 10_000, "KXBTC15M-A")]);
    const firstLine = lines(readFileSync(path, "utf8"))[0];
    const close = OPEN + WINDOW_MS;
    const settled = advanceBtc15Calls(ledger, [
      windowInput(OPEN, close, "KXBTC15M-A", {
        floorStrike: 100,
        expirationValue: 110,
      }),
    ]);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].kind, "settlement");
    if (settled[0].kind !== "settlement") return;
    assert.equal(settled[0].outcome, "UP");
    assert.equal(settled[0].initialHit, false);
    const text = readFileSync(path, "utf8");
    assert.equal(lines(text)[0], firstLine);
    assert.equal(readJsonlEvents(text).map((event) => event.type).join(","), "initial,settlement");

    const again = advanceBtc15Calls(ledger, [
      windowInput(OPEN, close + 1_000, "KXBTC15M-A", {
        floorStrike: 100,
        expirationValue: 50,
      }),
    ]);
    assert.deepEqual(again, []);
    assert.equal(readFileSync(path, "utf8"), text);
  });

  it("does not invent a settlement for a miss or a missing strike", () => {
    const missed = book();
    const close = OPEN + WINDOW_MS;
    advanceBtc15Calls(missed, [windowInput(OPEN, OPEN + 1_000, "KXBTC15M-A")]);
    const late = advanceBtc15Calls(missed, [
      windowInput(OPEN, close, "KXBTC15M-A", {
        floorStrike: 100,
        expirationValue: 110,
      }),
    ]);
    assert.equal(late.some((action) => action.kind === "settlement"), false);
    assert.equal(missed.all().some((event) => event.type === "settlement"), false);

    const locked = book();
    advanceBtc15Calls(locked, [windowInput(OPEN, OPEN - 10_000, "KXBTC15M-A")]);
    const noStrike = advanceBtc15Calls(locked, [
      windowInput(OPEN, close, "KXBTC15M-A", {
        floorStrike: null,
        expirationValue: 110,
      }),
    ]);
    assert.deepEqual(noStrike, []);
    assert.equal(locked.all().some((event) => event.type === "initial"), true);
    assert.equal(locked.all()[0].type === "initial" && locked.all()[0].decision.strike, null);
  });
});

describe("loop backoff", () => {
  it("returns to the base cadence after success and caps error backoff under a minute", () => {
    assert.equal(LOOP_TICK_MS, 8_000);
    assert.ok(LOOP_BACKOFF_CAP_MS < 60_000);
    assert.equal(nextTickDelay(8_000, false), 8_000);
    assert.equal(nextTickDelay(8_000, true), 16_000);
    assert.equal(nextTickDelay(16_000, true), 20_000);
    assert.equal(nextTickDelay(20_000, true), 20_000);
    assert.equal(nextTickDelay(20_000, false), 8_000);
  });
});

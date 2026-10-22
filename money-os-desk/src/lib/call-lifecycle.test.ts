import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leanVsLevel, type Bar1m } from "./engine";
import { CallLedger, MemoryStore } from "./call-ledger";
import {
  advanceBtc15Calls,
  CallLifecycleError,
  lockInitialCall,
  reviseAtHalfway,
  settleCall,
  type Btc15CallInput,
} from "./call-lifecycle";
import { listedWindowFromMarket } from "./kalshi";
import {
  AT_STRIKE_EPSILON_USD,
  CHECKPOINT_TOLERANCE_MS,
  HALFWAY_MS,
  compareToStrike,
} from "./strike-call";

const OPEN = Date.parse("2026-10-22T18:45:00.000Z");
const CLOSE = OPEN + 15 * 60 * 1000;

function ledger(): CallLedger {
  return new CallLedger(new MemoryStore());
}

function bars(
  end: number,
  count: number,
  direction: "up" | "down"
): Bar1m[] {
  const out: Bar1m[] = [];
  for (let i = 0; i < count; i++) {
    const t = end - (count - i) * 60_000;
    const open = direction === "up" ? 100 + i : 200 - i;
    const close = direction === "up" ? open + 1 : open - 1;
    out.push({
      t,
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      close,
      volume: i === count - 1 ? 40 : 5,
    });
  }
  return out;
}

function input(now: number, patch: Partial<Btc15CallInput> = {}): Btc15CallInput {
  return {
    ticker: "KXBTC15M-TEST-00",
    openTime: new Date(OPEN).toISOString(),
    closeTime: new Date(CLOSE).toISOString(),
    floorStrike: null,
    spot: null,
    bars: [],
    now,
    ...patch,
  };
}

describe("strike epsilon", () => {
  it("treats equality and a one-cent band as AT STRIKE", () => {
    assert.equal(AT_STRIKE_EPSILON_USD, 0.01);
    assert.equal(compareToStrike(100, 100), "AT STRIKE");
    assert.equal(compareToStrike(100.01, 100), "AT STRIKE");
    assert.equal(compareToStrike(99.99, 100), "AT STRIKE");
    assert.equal(compareToStrike(100.02, 100), "UP");
    assert.equal(compareToStrike(99.98, 100), "DOWN");
    assert.equal(leanVsLevel(100, 100), "AT STRIKE");
    assert.notEqual(leanVsLevel(100, 100), "UP");
  });
});

describe("pre-start lock", () => {
  it("locks before the window opens and refuses the first lock at or after open", () => {
    const book = ledger();
    const locked = lockInitialCall(
      book,
      input(OPEN - 1, {
        bars: bars(OPEN - 1, 30, "up"),
        spot: { price: 130, ts: OPEN - 1, source: "kraken" },
      })
    );
    assert.equal(locked.initial.call, "UP");
    assert.equal(locked.initial.at, OPEN - 1);
    assert.equal(locked.finalCall, "UP");
    assert.equal(book.all().length, 1);

    const late = ledger();
    assert.throws(
      () => lockInitialCall(late, input(OPEN)),
      (error: unknown) =>
        error instanceof CallLifecycleError && error.code === "TOO_LATE_TO_LOCK"
    );
    assert.throws(
      () => lockInitialCall(late, input(OPEN + 1)),
      (error: unknown) =>
        error instanceof CallLifecycleError && error.code === "TOO_LATE_TO_LOCK"
    );
    assert.equal(late.all().length, 0);
  });

  it("keeps the locked call immutable when a later read would project the other way", () => {
    const book = ledger();
    const first = lockInitialCall(
      book,
      input(OPEN - 60_000, {
        bars: bars(OPEN - 60_000, 30, "up"),
        spot: { price: 130, ts: OPEN - 60_000, source: "kraken" },
      })
    );
    const second = lockInitialCall(
      book,
      input(OPEN - 1_000, {
        bars: bars(OPEN - 1_000, 30, "down"),
        spot: { price: 90, ts: OPEN - 1_000, source: "kraken" },
        floorStrike: 100,
      })
    );
    assert.equal(second.initial.call, "UP");
    assert.equal(second.initial.at, first.initial.at);
    assert.equal(second.initial.why, first.initial.why);
    assert.equal(book.all().length, 1);
    assert.equal(book.all()[0].type === "initial" && book.all()[0].decision.call, "UP");
  });

  it("treats a Kalshi Z timestamp and a millisecond timestamp as one window", () => {
    const book = ledger();
    const first = lockInitialCall(
      book,
      input(OPEN - 1_000, {
        openTime: "2026-10-22T18:45:00Z",
        closeTime: "2026-10-22T19:00:00Z",
        bars: bars(OPEN - 1_000, 30, "up"),
        spot: { price: 130, ts: OPEN - 1_000, source: "kraken" },
      })
    );
    const second = lockInitialCall(
      book,
      input(OPEN - 500, {
        openTime: "2026-10-22T18:45:00.000Z",
        closeTime: "2026-10-22T19:00:00.000Z",
        bars: bars(OPEN - 500, 30, "down"),
        spot: { price: 90, ts: OPEN - 500, source: "kraken" },
      })
    );
    assert.equal(book.all().length, 1);
    assert.equal(second.initial.call, first.initial.call);
    assert.equal(second.initial.at, first.initial.at);
  });
});

describe("halfway revision", () => {
  it("allows one revision at the checkpoint and none before it or after it", () => {
    const book = ledger();
    lockInitialCall(
      book,
      input(OPEN - 30_000, {
        floorStrike: 100,
        bars: bars(OPEN - 30_000, 30, "down"),
        spot: { price: 90, ts: OPEN - 30_000, source: "kraken" },
      })
    );
    assert.equal(book.all()[0].type === "initial" && book.all()[0].decision.call, "DOWN");

    const halfway = OPEN + HALFWAY_MS;
    assert.throws(
      () =>
        reviseAtHalfway(
          book,
          input(halfway - 1, {
            floorStrike: 100,
            spot: { price: 110, ts: halfway - 1, source: "kraken" },
            bars: bars(halfway - 1, 30, "down"),
          })
        ),
      (error: unknown) =>
        error instanceof CallLifecycleError && error.code === "TOO_EARLY_TO_REVISE"
    );
    assert.equal(book.all().length, 1);

    const revised = reviseAtHalfway(
      book,
      input(halfway, {
        floorStrike: 100,
        spot: { price: 110, ts: halfway, source: "kraken" },
        bars: bars(halfway, 30, "down"),
      })
    );
    assert.equal(revised.initial.call, "DOWN");
    assert.equal(revised.revision?.call, "UP");
    assert.equal(revised.revision?.effect, "flip");
    assert.equal(revised.finalCall, "UP");
    assert.equal(revised.revision?.agreement, "weak");
    assert.ok(revised.revision?.evidence.some((row) => row.role === "CONFLICTS"));
    assert.match(revised.revision?.why ?? "", /Flipped/);
    assert.equal(book.all().length, 2);

    assert.throws(
      () =>
        reviseAtHalfway(
          book,
          input(halfway + 10_000, {
            floorStrike: 100,
            spot: { price: 80, ts: halfway + 10_000, source: "kraken" },
            bars: bars(halfway + 10_000, 30, "up"),
          })
        ),
      (error: unknown) =>
        error instanceof CallLifecycleError && error.code === "ALREADY_REVISED"
    );
    assert.equal(book.all().length, 2);
    assert.equal(revised.revision?.call, "UP");

    const lateBook = ledger();
    lockInitialCall(lateBook, input(OPEN - 5_000, { bars: bars(OPEN - 5_000, 30, "up") }));
    assert.throws(
      () =>
        reviseAtHalfway(
          lateBook,
          input(halfway + CHECKPOINT_TOLERANCE_MS, {
            floorStrike: 100,
            spot: { price: 80, ts: halfway, source: "kraken" },
          })
        ),
      (error: unknown) =>
        error instanceof CallLifecycleError && error.code === "CHECKPOINT_PASSED"
    );
    assert.equal(lateBook.all().length, 1);
    const folded = lateBook.all();
    assert.equal(folded[0].type === "initial" && folded[0].decision.call, "UP");
  });

  it("records a keep when the halfway comparison matches the lock", () => {
    const book = ledger();
    lockInitialCall(
      book,
      input(OPEN - 10_000, {
        floorStrike: 100,
        bars: bars(OPEN - 10_000, 30, "up"),
        spot: { price: 130, ts: OPEN - 10_000, source: "kraken" },
      })
    );
    const halfway = OPEN + HALFWAY_MS;
    const revised = reviseAtHalfway(
      book,
      input(halfway + CHECKPOINT_TOLERANCE_MS - 1, {
        floorStrike: 100,
        spot: { price: 130, ts: halfway, source: "kraken" },
        bars: bars(halfway, 30, "up"),
      })
    );
    assert.equal(revised.initial.call, "UP");
    assert.equal(revised.revision?.effect, "keep");
    assert.equal(revised.revision?.call, "UP");
    assert.match(revised.revision?.why ?? "", /Kept/);
  });

  it("uses the epsilon band at halfway, so equality is not UP", () => {
    const halfway = OPEN + HALFWAY_MS;
    for (const [price, expected] of [
      [100, "AT STRIKE"],
      [100.01, "AT STRIKE"],
      [99.99, "AT STRIKE"],
      [100.02, "UP"],
      [99.98, "DOWN"],
    ] as const) {
      const book = ledger();
      lockInitialCall(book, input(OPEN - 1_000));
      const revised = reviseAtHalfway(
        book,
        input(halfway, {
          floorStrike: 100,
          spot: { price, ts: halfway, source: "kraken" },
          bars: bars(halfway, 30, "up"),
        })
      );
      assert.equal(revised.revision?.call, expected, `price ${price}`);
    }
  });
});

describe("data quality does not suppress the call", () => {
  it("still calls from a stale quote and labels it STALE", () => {
    const now = OPEN - 20_000;
    const book = ledger();
    const state = lockInitialCall(
      book,
      input(now, {
        floorStrike: 100,
        spot: { price: 97, ts: now - 60_000, source: "kraken" },
        bars: bars(now - 5 * 60_000, 30, "down"),
      })
    );
    assert.equal(state.initial.quality, "STALE");
    assert.notEqual(state.initial.quality, "LIVE");
    assert.equal(state.initial.call, "DOWN");
    assert.equal(state.initial.price, 97);
    assert.equal(state.initial.strike, 100);
    assert.equal(state.initial.priceSource, "kraken_ticker");
  });

  it("still calls when the strike is unpublished and no quote exists, without filling in numbers", () => {
    const book = ledger();
    const state = lockInitialCall(book, input(OPEN - 5_000));
    assert.equal(state.initial.quality, "NO DATA");
    assert.equal(state.initial.call, "AT STRIKE");
    assert.equal(state.initial.price, null);
    assert.equal(state.initial.strike, null);
    assert.equal(state.initial.strikeSource, "unpublished");
    assert.match(state.initial.anchorNote, /does not invent/);
    assert.equal(state.finalCall, "AT STRIKE");
  });

  it("can be LIVE when the strike, quote, clock, and closed bars are all fresh", () => {
    const now = OPEN - 2_000;
    const book = ledger();
    const state = lockInitialCall(
      book,
      input(now, {
        floorStrike: 130,
        spot: { price: 131, ts: now - 1_000, source: "kraken" },
        bars: bars(now, 30, "up"),
      })
    );
    assert.equal(state.initial.quality, "LIVE");
    assert.ok(state.initial.call === "UP" || state.initial.call === "DOWN" || state.initial.call === "AT STRIKE");
  });
});

describe("settlement", () => {
  it("scores both calls and does not rewrite them", () => {
    const book = ledger();
    const openTime = new Date(OPEN).toISOString();
    const closeTime = new Date(CLOSE).toISOString();
    lockInitialCall(book, input(OPEN - 1_000));
    const halfway = OPEN + HALFWAY_MS;
    reviseAtHalfway(
      book,
      input(halfway, {
        floorStrike: 100,
        spot: { price: 110, ts: halfway, source: "kraken" },
        bars: bars(halfway, 30, "up"),
      })
    );
    const before = JSON.parse(JSON.stringify(book.all()[0]));
    const settled = settleCall(
      book,
      "KXBTC15M-TEST-00",
      openTime,
      closeTime,
      110,
      100,
      CLOSE + 1_000
    );
    assert.equal(settled.initial.call, "AT STRIKE");
    assert.equal(settled.revision?.call, "UP");
    assert.equal(settled.settlement?.outcome, "UP");
    assert.equal(settled.settlement?.initialHit, false);
    assert.equal(settled.settlement?.finalHit, true);
    assert.deepEqual(book.all()[0], before);

    const tie = ledger();
    lockInitialCall(tie, input(OPEN - 1_000));
    const tied = settleCall(
      tie,
      "KXBTC15M-TEST-00",
      openTime,
      closeTime,
      100,
      100,
      CLOSE
    );
    assert.equal(tied.settlement?.outcome, "AT STRIKE");
    assert.equal(tied.settlement?.initialHit, true);
    assert.equal(tied.initial.call, "AT STRIKE");
    assert.throws(
      () =>
        settleCall(tie, "KXBTC15M-TEST-00", openTime, closeTime, 100, 100, CLOSE),
      (error: unknown) =>
        error instanceof CallLifecycleError && error.code === "ALREADY_SETTLED"
    );
  });
});

describe("advance", () => {
  it("locks only before open and revises only inside the checkpoint", () => {
    const book = ledger();
    const before = advanceBtc15Calls(book, [input(OPEN - 1_000, { bars: bars(OPEN - 1_000, 30, "up") })]);
    assert.equal(before.length, 1);
    assert.equal(book.all().length, 1);

    advanceBtc15Calls(book, [input(OPEN + 60_000, { floorStrike: 100, spot: { price: 50, ts: OPEN, source: "kraken" } })]);
    assert.equal(book.all().length, 1);

    const halfway = OPEN + HALFWAY_MS;
    advanceBtc15Calls(book, [
      input(halfway, {
        floorStrike: 100,
        spot: { price: 140, ts: halfway, source: "kraken" },
        bars: bars(halfway, 30, "up"),
      }),
    ]);
    assert.equal(book.all().length, 2);

    advanceBtc15Calls(book, [
      input(halfway + CHECKPOINT_TOLERANCE_MS, {
        floorStrike: 100,
        spot: { price: 50, ts: halfway, source: "kraken" },
      }),
    ]);
    assert.equal(book.all().length, 2);
    assert.equal(book.all()[1].type === "revision" && book.all()[1].revision.call, "UP");

    const missed = ledger();
    const missedActions = advanceBtc15Calls(missed, [input(OPEN + 1_000)]);
    assert.equal(missedActions.length, 1);
    assert.equal(missedActions[0].kind, "missed");
    assert.equal(missed.all().length, 1);
    assert.equal(missed.all()[0].type, "missed");
    assert.equal(
      missed.all().some((event) => event.type === "initial"),
      false
    );
  });
});

describe("Kalshi listed windows", () => {
  it("keeps an unpublished strike null and reads a published floor_strike", () => {
    const tbd = listedWindowFromMarket({
      ticker: "KXBTC15M-26OCT222215-15",
      event_ticker: "KXBTC15M-26OCT222215",
      status: "initialized",
      open_time: "2026-10-23T02:00:00Z",
      close_time: "2026-10-23T02:15:00Z",
      yes_sub_title: "Target price: TBD",
    });
    assert.ok(tbd);
    assert.equal(tbd.floorStrike, null);
    assert.equal(tbd.yesSubTitle, "Target price: TBD");

    const printed = listedWindowFromMarket({
      ticker: "KXBTC15M-26OCT221500-00",
      event_ticker: "KXBTC15M-26OCT221500",
      status: "closed",
      open_time: "2026-10-22T18:45:00Z",
      close_time: "2026-10-22T19:00:00Z",
      floor_strike: 81205.83,
      strike_type: "greater_or_equal",
      yes_sub_title: "Target Price: $81,205.83",
      expiration_value: "",
    });
    assert.equal(printed?.floorStrike, 81205.83);
    assert.equal(printed?.strikeType, "greater_or_equal");
    assert.equal(printed?.expirationValue, null);
  });
});

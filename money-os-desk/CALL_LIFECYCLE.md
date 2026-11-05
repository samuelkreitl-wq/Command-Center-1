# BTC15 call lifecycle

The desk call is UP, DOWN, or AT STRIKE. Every 15-minute window gets one. LIVE, STALE, and NO DATA describe the inputs attached to that call. They do not cancel it.

## What Kalshi actually publishes

Checked against the public market API on 2026-10-22T19:00:19Z. No API key.

`KXBTC15M` asks whether the 60-second CF Benchmarks BRTI average in the minute before `close_time` is **at least** the 60-second average in the minute before `open_time`. The series record points at CF Benchmarks. On a printed market, `strike_type` is `greater_or_equal` and `floor_strike` is that opening average, to the cent.

The same minute settles one window and opens the next, so the next `floor_strike` normally equals the previous `expiration_value`. Three consecutive finalized windows that hour:

| Ticker | Open (UTC) | floor_strike | expiration_value | Result |
|---|---|---|---|---|
| `KXBTC15M-26OCT221415-15` | 18:00 | 81101.69 | 81008.07 | no |
| `KXBTC15M-26OCT221430-30` | 18:15 | 81008.07 | 81065.41 | yes |
| `KXBTC15M-26OCT221445-45` | 18:30 | 81065.41 | 81205.83 | yes |

The following window, `KXBTC15M-26OCT221500-00` (18:45–19:00), already showed `floor_strike` 81205.83. Its `expiration_value` was still empty in the minute after close.

Windows that have not reached that minute do not have a strike. `KXBTC15M-26OCT222215-15` (open 2026-10-23T02:00:00Z) was `initialized`, created 2026-10-21T20:01:33Z, subtitle `Target price: TBD`, and the payload had **no** `floor_strike` field. The rules text already names the two minutes. It does not name the number.

So the official strike is known at or just after the open, when the pre-open minute has finished and Kalshi prints it. It is not known the day the window is listed. A lock that must happen before `open_time` cannot wait for that print.

## How the pre-start call is anchored

`lockInitialCall` runs only while `now < openTime`. It stores one decision and will not replace it.

- If Kalshi has already published `floor_strike`, that number is stored as the strike (`strikeSource: "kalshi_floor_strike"`).
- If the field is missing, the strike stays `null` (`strikeSource: "unpublished"`). The previous window's expiration is not copied in and labeled as this strike. Doing that would present a different, often still-unsettled, print as this window's official number.
- The call itself is a trend projection from closed 1-minute bars: RSI(7), EMA9 against EMA21, price against the last 15 closed bars' VWAP, and volume only when the last closed bar expands past the median volume and has a direction. More up votes than down votes is UP, the reverse is DOWN, and a tie (including no votes at all) is AT STRIKE. UP means the close average is projected to finish above the open average. DOWN means below. AT STRIKE means inside the one-cent band.
- Spot versus strike is an evidence citation when both numbers exist. It is not a vote, because the window has not started.

No code path substitutes a made-up price or a made-up strike. A missing quote falls back to the last **closed** Kraken 1-minute close, which is a real print, and the source is recorded as `kraken_1m_close`. If that is missing too, `price` stays null.

## Halfway, then final

The checkpoint opens at 7.5 minutes after `openTime` and lasts 60 seconds (`CHECKPOINT_TOLERANCE_MS`). The feed's usual 8-second poll fits in that window. One revision may be written there.

When both a Kraken price and a published `floor_strike` exist, the revision is that comparison:

- The prices are rounded to integer cents first, then a gap of 1 cent or less is AT STRIKE. Comparing the dollar floats directly would push 100.01 just outside a 0.01 band.
- price above the band → UP
- price below the band → DOWN

Equality is AT STRIKE. That is deliberate, and it is not Kalshi's contract tie-break. The contract pays Yes on an exact tie (`greater_or_equal`). Paper settlement in `paper.ts` still follows the contract (`endPx >= strike` → UP). Call accuracy uses the band, so an AT STRIKE call can be scored.

Indicators at halfway are SUPPORTS, CONFLICTS, or NEUTRAL citations with the raw RSI, EMAs, VWAP, and volume. They do not move the comparison. Agreement is `strong` when at least two citations support the call and none conflict, otherwise `weak`. Agreement never changes the call.

Before the checkpoint, a revision is rejected. After it, the call is final and a revision is rejected. A second revision is rejected. If the strike is still unpublished at halfway, the revision stays on the trend projection and says so. It does not invent the strike.

`advanceBtc15Calls` only locks in the pre-start phase and only revises inside the checkpoint. A window that is first seen after open does not receive a late initial call.

## Storage and scoring

`CallLedger` appends `initial`, `revision`, and `settlement` events. It does not edit an event after append. Browser `localStorage` key: `moneyos.btc.callLedger.v1`. Tests use an in-memory store.

Settlement adds `outcome`, `initialHit`, and `finalHit`. A hit means the call equals the outcome under the same epsilon rule. The initial decision and the revision stay as written. A second settlement is rejected.

## Data-quality flag

The flag on a decision is the worst of four parts:

| Part | LIVE | STALE | NO DATA |
|---|---|---|---|
| Kraken quote | Age ≤ 15s | Older verified quote | No verified price |
| Strike | Published `floor_strike` | — | Missing or not a positive number |
| Clock | Open, close, and a 15-minute span | — | Bad timestamps |
| Closed 1m bars | At least 21, last bar ended within 120s | At least 21, older than that | Fewer than 21 |

A STALE or NO DATA decision is still a call. The flag is stored with it. A stale quote is not labeled LIVE.

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

`advanceBtc15Calls` locks only the single soonest future window, and only during the last 120 seconds before its `openTime` (`LOCK_LEAD_MS`). A snapshot that lists the rest of the day does not lock those windows. The same pass revises a window that is already locked and is inside its halfway checkpoint. A window first seen after open is not locked late.

## Storage and scoring

`CallLedger` appends `initial`, `revision`, `settlement`, and `missed` events. It does not edit an event after append. The desk facade still uses browser `localStorage` key `moneyos.btc.callLedger.v1`. The unattended runner uses an append-only JSONL file instead (see below). Tests use an in-memory store or a temp file.

Settlement adds `outcome`, `initialHit`, and `finalHit`. A hit means the call equals the outcome under the same epsilon rule. The initial decision and the revision stay as written. A second settlement is rejected. Settlement is written only when the window already has a pre-start lock, Kalshi has published both `floor_strike` and a positive `expiration_value`, and `now` is at or after close. A missed window is not settled.

## Missed windows

If the process is down at lock time, the window is recorded as `missed` once it is seen open, or within 20 minutes after it closes. The record says the process had no call on file, so none was invented. It is not a call, it is not revised, and it is not settled. A second pass does not write the miss again. Windows older than that lookback are left untouched, so startup does not mark the settled history.

## Unattended runner

From `money-os-desk`:

```bash
npm install
npm test
npm run btc15:loop
```

The process is a long-running Node loop. It does not open a screen. Each healthy pass starts about 8 seconds after the previous one (`LOOP_TICK_MS`), which is enough to land in the 60-second halfway checkpoint. The clock is the wall-clock `open_time` / `close_time` on each KXBTC15M market, so every 15-minute window is handled without a manual start.

Each pass reads public Kraken `XBTUSD` and public Kalshi `KXBTC15M` (open, unopened, and settled). There is no API key and no order path. Those GETs time out after 8 seconds. A failed read is logged to stderr and the next wait doubles, up to 20 seconds, then returns to 8 seconds after a clean pass. The process keeps running.

Stdout gets one line when the ledger changes, and nothing on an idle pass:

```text
2026-10-22T19:28:00.000Z LOCK KXBTC15M-… DOWN quality=NO DATA agreement=strong
2026-10-22T19:37:30.000Z REVISE KXBTC15M-… FLIP DOWN -> UP quality=LIVE
2026-10-22T19:45:10.000Z SETTLE KXBTC15M-… outcome=UP initialHit=false finalHit=true
2026-10-22T19:15:08.000Z MISSED KXBTC15M-… no pre-start lock
```

The ledger path is `money-os-desk/data/btc15-calls.jsonl`, next to the script file, unless `BTC15_LEDGER` is an absolute path. That directory is gitignored. Each event is one JSON line, appended and fsynced. Earlier lines are never rewritten. On startup the file is loaded, so a restart still has the lock and can still do the halfway check. A torn last line is skipped. Run one process against a given file. Two writers can each append a lock for the same window.

SIGINT and SIGTERM finish the current wait and exit 0.

Keep it running on a Mac, from the `money-os-desk` directory. The log below is also gitignored because it sits in `data/`.

`nohup`:

```bash
mkdir -p data
nohup npm run btc15:loop >> data/btc15-loop.log 2>&1 &
echo $! > data/btc15-loop.pid
```

Stop with `kill "$(cat data/btc15-loop.pid)"`.

`pm2`:

```bash
npm install -g pm2
pm2 start npm --name btc15-loop -- run btc15:loop
pm2 save
```

`launchd`, saved as `~/Library/LaunchAgents/com.moneyos.btc15-loop.plist` (replace the two path strings):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.moneyos.btc15-loop</string>
  <key>WorkingDirectory</key>
  <string>/ABS/PATH/money-os-desk</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npm</string>
    <string>run</string>
    <string>btc15:loop</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/ABS/PATH/money-os-desk/data/btc15-loop.log</string>
  <key>StandardErrorPath</key>
  <string>/ABS/PATH/money-os-desk/data/btc15-loop.log</string>
</dict>
</plist>
```

```bash
mkdir -p data
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.moneyos.btc15-loop.plist
```

`npm` must be the same binary that can see this folder's `node_modules` (`which npm`).

## Data-quality flag

The flag on a decision is the worst of four parts:

| Part | LIVE | STALE | NO DATA |
|---|---|---|---|
| Kraken quote | Age ≤ 15s | Older verified quote | No verified price |
| Strike | Published `floor_strike` | — | Missing or not a positive number |
| Clock | Open, close, and a 15-minute span | — | Bad timestamps |
| Closed 1m bars | At least 21, last bar ended within 120s | At least 21, older than that | Fewer than 21 |

A STALE or NO DATA decision is still a call. The flag is stored with it. A stale quote is not labeled LIVE.

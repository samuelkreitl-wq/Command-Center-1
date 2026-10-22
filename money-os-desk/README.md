# Money OS Desk — Phase 1+2 modules

Drop into Command Center / Replit under `src/lib/` (or `src/lib/money-os/`).

## Files

| File | Role |
|------|------|
| `types.ts` | Contract, lock, paper, snapshot types (+ Fear & Greed) |
| `strike-call.ts` | Last vs strike, one-cent AT STRIKE band, halfway timing |
| `call-lifecycle.ts` | Pre-start lock, one halfway revision, settlement scoring |
| `call-ledger.ts` | Append-only initial / revision / settlement / missed events |
| `jsonl-ledger.ts` | JSONL file ledger for the unattended runner |
| `btc15-loop.ts` | `npm run btc15:loop` — one process, no screen |
| `signal-lock.ts` | Legacy core lock for the paper journal |
| `engine.ts` | RSI(7), EMA9/21, VWAP, volume readings |
| `hard-stop.ts` | Cooldown after miss |
| `paper.ts` | Paper YES/NO (not sent to Kalshi). Tie follows the contract (Yes) |
| `journal.ts` | localStorage journal + trade log |
| `desk.ts` | Facade: snapshot, lock, paper, settle |
| `kraken.ts` | **Live** REST ticker + 1m OHLC |
| `kalshi.ts` | **Live** KXBTC15M markets + orderbook |
| `feeds.ts` | Poll loop → buildSnapshot (includes Fear & Greed) |
| `fear-greed.ts` | **Live** Crypto Fear & Greed Index (alternative.me) |

## Live feeds

Public data only — no API keys.

```ts
import { startFeedLoop } from "./feeds";

const stop = startFeedLoop((b) => {
  // b.contract?.strike, b.spot?.price, b.snapshot.leanVsStrike
  // b.fearGreed?.current?.value, b.fearGreed?.current?.classification
  // b.errors
}, { market: "15m", intervalMs: 8000 });
```

5m: `SERIES_5M` is null until Kalshi lists a series.

## Fear & Greed

- Source: https://api.alternative.me/fng/
- Current value (0–100) + classification (Extreme Fear / Fear / Neutral / Greed / Extreme Greed)
- Also yesterday and ~last week
- Available on every snapshot as `snapshot.fearGreed`

## BTC15 call

See [CALL_LIFECYCLE.md](./CALL_LIFECYCLE.md).

- Every window gets UP, DOWN, or AT STRIKE. The quality flag does not cancel it.
- The initial call locks before `openTime` and is not rewritten.
- One revision is allowed during the 60s checkpoint at 7.5 minutes. Then the call is final.
- In-window comparison is Kraken last vs the published `floor_strike`, with a $0.01 AT STRIKE band. Equality is AT STRIKE.
- Before the strike is published the pre-start call is a trend projection and the strike field stays null.
- Agreement is strong or weak and does not change the call.
- `npm run btc15:loop` locks only the next window in the last 120 seconds before open, revises once at halfway, and appends settlement when Kalshi publishes `expiration_value`. The ledger is `data/btc15-calls.jsonl` (gitignored) and is reloaded on startup. A window with no pre-start lock is marked missed and is not invented later.
- Run `npm test` in this folder. Keeping the loop up on a Mac (`nohup`, `pm2`, `launchd`) is in [CALL_LIFECYCLE.md](./CALL_LIFECYCLE.md).

## Other rules

- Paper settles vs strike, not custom ref. An exact tie is UP, matching the Kalshi Yes rule.
- Hard-stop blocks paper after a miss.

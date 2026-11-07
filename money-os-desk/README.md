# Money OS Desk — Phase 1+2 modules

Drop into Command Center / Replit under `src/lib/` (or `src/lib/money-os/`).

## Files

| File | Role |
|------|------|
| `types.ts` | Contract, lock, paper, snapshot types |
| `signal-lock.ts` | Immutable core lock |
| `engine.ts` | RSI/EMA/VWAP heuristic + book action |
| `hard-stop.ts` | Cooldown after miss |
| `paper.ts` | Paper YES/NO (not sent to Kalshi) |
| `journal.ts` | localStorage journal + trade log |
| `desk.ts` | Facade: snapshot, lock, paper, settle |
| `kraken.ts` | **Live** REST ticker + 1m OHLC |
| `kalshi.ts` | **Live** KXBTC15M markets + orderbook |
| `feeds.ts` | Poll loop → buildSnapshot |

## Live feeds

Public data only — no API keys.

```ts
import { startFeedLoop } from "./feeds";

const stop = startFeedLoop((b) => {
  // b.contract?.strike, b.spot?.price, b.snapshot.leanVsStrike, b.errors
}, { market: "15m", intervalMs: 8000 });
```

5m: `SERIES_5M` is null until Kalshi lists a series.

## Rules

- A call is only UP, DOWN, or AT STRIKE, and only against that window's own Kalshi `floor_strike`. Equality in cents is AT STRIKE. The desk never locks against another market's strike, a settled end price, or the Kraken spot.
- Until `floor_strike` is posted, the window shows "no call" and no strike number. Nothing is locked.
- The desk polls every 8 seconds (`DESK_POLL_MS`). "Immediately" means that poll: the first one where the desk was already watching the window, Kalshi's own `floor_strike` is present, and the Kraken spot is fresh (received within 30 seconds). The call is UP, DOWN, or AT STRIKE against that strike.
- A fresh spot that arrives only after `open+5:00` does not lock. If no call is committed before that instant, the window is MISSED and stays MISSED. A stale spot never locks. While the spot is stale and the 5:00 deadline has not passed, the window stays "no call" and the header reads STALE, not LIVE.
- The first time a window is seen with `floor_strike` already posted, the desk was not running for it. That window is MISSED and is not back-filled.
- One change is allowed only on the ten-minute tick: `open+10:00` inclusive through `open+10:00` plus 8 seconds, exclusive. The reason is stored on the journal row. A second change in that tick is refused and the refusal is stored. After `open+10:00` plus 8 seconds the call is locked for the rest of the window, and a change attempt is refused and stored. A stale spot cannot apply a change and does not use up the one change.
- Stale or failed feeds are labelled STALE and are not labelled live.
- Settlement of a recorded call: endPx >= strike → UP
- Paper settles vs strike, not custom ref
- Hard-stop blocks paper after a miss


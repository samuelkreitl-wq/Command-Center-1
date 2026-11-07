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

- Every 15-minute window the desk is watching gets one call: UP, DOWN, or AT STRIKE. Equality with the strike, in cents, is AT STRIKE.
- The call locks by itself before the window opens. No button is required for that lock.
- Expected strike, used only before Kalshi publishes `floor_strike`: this window's own posted strike, else the other open market's strike, else the newest settled end price, else the fresh Kraken last rounded to the cent. A spot-only reference locks AT STRIKE. A null strike does not throw. When the official strike arrives it is stored beside the call and the call stays as locked.
- One optional change, only at or after halfway, with the reason stored on the journal row. A second change is refused, that refusal is stored, and it cannot be approved later.
- A window that is already open and has no earlier lock is MISSED. It is not given a call later.
- Stale or failed feeds are labelled STALE and are not labelled live.
- Settlement of a recorded call: endPx >= strike → UP
- Paper settles vs strike, not custom ref
- Hard-stop blocks paper after a miss


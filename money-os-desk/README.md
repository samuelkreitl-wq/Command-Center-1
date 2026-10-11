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

- First core lock per window is permanent
- Settlement: endPx >= strike → UP
- Paper settles vs strike, not custom ref
- Hard-stop blocks paper after a miss

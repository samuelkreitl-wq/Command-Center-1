# Money OS Desk — Phase 1+2 modules

Drop into Command Center / Replit under `src/lib/` (or `src/lib/money-os/`).

## Files

| File | Role |
|------|------|
| `types.ts` | Contract, lock, paper, snapshot types |
| `signal-lock.ts` | **Immutable** core lock, scalp helper, settle |
| `engine.ts` | RSI/EMA/VWAP heuristic + book action |
| `hard-stop.ts` | Cooldown after miss |
| `paper.ts` | Paper YES/NO (not sent to Kalshi) |
| `journal.ts` | localStorage journal + trade log |
| `desk.ts` | Facade: snapshot, lock, paper, settle |

## Rules enforced

- First core lock per `ticker::closeTime` is permanent
- Settlement: `endPx >= strike → UP` (YES)
- Paper PnL uses strike, not custom ref
- Hard-stop blocks paper after a miss
- Evidence win rate is `—` until settled locks exist

## Wire UI later

1. Poll/WS → `SpotTick` + 1m `Bar1m[]` + Kalshi `ContractWindow`
2. `buildSnapshot(...)` each tick
3. Lock button → `lockFromLive(...)`
4. Paper YES/NO → `placePaper(...)`
5. On window end → `settleWindow(contract, endPx)`

## Not included yet

- Live Kalshi order send
- On-chain badges
- React components
- Postgres (swap journal.ts storage when ready)

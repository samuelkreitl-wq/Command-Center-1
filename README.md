# Command-Center-1

System of record for Money OS / Kalshi short-window desk.

## Money OS Desk (Phase 1+2)

See [`money-os-desk/`](./money-os-desk/) for:

- Immutable core lock (UP/DOWN per window)
- Heuristic engine (RSI/EMA/VWAP + book action)
- Paper YES/NO trades (not sent to Kalshi)
- Hard-stop after miss
- Journal + trade log (localStorage-ready)

Wire UI against `money-os-desk/src/lib/desk.ts`.

# Command-Center-1

System of record for Money OS / Kalshi short-window desk.

## Money OS Desk (Phase 1+2)

See [`money-os-desk/`](./money-os-desk/) for:

- BTC15 call locked before the window, one halfway revision (UP / DOWN / AT STRIKE)
- Indicator evidence (RSI/EMA/VWAP/volume) that does not override the call
- Paper YES/NO trades (not sent to Kalshi)
- Hard-stop after miss
- Journal + trade log (localStorage-ready)

Wire UI against `money-os-desk/src/lib/desk.ts`.

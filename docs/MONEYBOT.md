# moneybot (Python) inside Command Center

`moneybot/` is the read-only value-model engine that Samuel's money desk runs on the box. It sits alongside the existing TypeScript scanner, auto-order and exit code (`server/scan.ts`, `server/fair.ts`, `server/orders.ts`, …) and does not replace or import any of them.

- It never places, changes or cancels an order. It has no Kalshi signing code and no order endpoints.
- The server can call it as a subprocess, `python3 -m moneybot scan --json`. That returns picks with venue, fair value, the predicted settlement value ± sigma, edge after fees and a quarter-Kelly stake, plus cross-venue comparisons.
- Ledgers and calibration are written to `moneybot/data/` (gitignored).
- Wiring it into `server/scan.ts` or the UI is a follow-up and needs Samuel's review.

See `moneybot/README.md` for the model.

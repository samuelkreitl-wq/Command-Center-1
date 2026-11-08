# Money OS / Command Center

## Run
- Node.js 20, React, TypeScript and Vite. Install with `npm install`.
- Replit workflow: **Start application**, command `npm run dev`.
- Dev server listens on `0.0.0.0:5000` and accepts Replit's proxied hosts.
- `npm run build` checks TypeScript and builds `dist/`; `npm start` serves the build on port 5000.
- `npm test` checks core lock immutability, paper trades, settlement, hard-stop, references and feed mapping.
- `npm run test:browser` checks the main UI flows with explicit test-only feed fixtures. Start the app first. Uses Replit's Chromium (or set `CHROMIUM_PATH`).

## Structure and data
- The imported TypeScript modules remain in `money-os-desk/src/lib/`.
- The basic React interface is in `money-os-desk/src/`; root Vite config points to that existing directory.
- Public Kraken and Kalshi requests use fixed same-origin proxies `/api/kraken` and `/api/kalshi` in both development and build preview. No API keys or additional secrets required.
- All positions are **paper only**. There is no real order execution.
- Journal, paper trades and custom reference persist in this browser's localStorage only; they are not synced or backed up to a server.
- Only the listed 15-minute series is supported. Missing/unavailable feeds must be displayed explicitly, never replaced with sample market data.
- Settlement is manual, after expiry, against the recorded strike. The user supplies the final price; Kraken spot is not the official Kalshi settlement index (Kalshi uses a CF Benchmarks average).
- Signals are heuristic, not calibrated probabilities or financial advice.


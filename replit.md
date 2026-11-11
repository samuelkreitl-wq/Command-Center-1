# Money OS / Command Center

## Run
- Node.js 20, React, TypeScript and Vite. Install with `npm install`.
- Replit workflow: **Start application**, command `npm run dev`.
- That command is the long-running Node server on `0.0.0.0:5000`. Leave it up on a Reserved VM so the hourly ET scan keeps running. The scan never places an order.
- `npm run build` checks TypeScript and builds `dist/`. `npm start` serves that build with the same scanner (`NODE_ENV=production`).
- `npm test` checks the desk rules plus the order password gate.
- `npm run test:browser` checks the BTC desk with explicit test-only feed fixtures. Start the app first. Uses Replit's Chromium (or set `CHROMIUM_PATH`).
- Secrets are environment variables only. See the root README. Do not put key values in the repo.

## Structure and data
- The imported TypeScript modules remain in `money-os-desk/src/lib/`.
- The basic React interface is in `money-os-desk/src/`; root Vite config points to that existing directory.
- Public Kraken and Kalshi requests use fixed same-origin proxies `/api/kraken` and `/api/kalshi` in both development and build preview. No API keys or additional secrets required.
- The BTC journal and paper book stay in this browser. A live order is a separate Place bet action and is refused without the approval password.
- Journal, paper trades and custom reference persist in this browser's localStorage only; they are not synced or backed up to a server.
- Only the listed 15-minute series is supported. Missing/unavailable feeds must be displayed explicitly, never replaced with sample market data.
- Settlement is manual, after expiry, against the recorded strike. The user supplies the final price; Kraken spot is not the official Kalshi settlement index (Kalshi uses a CF Benchmarks average).
- Signals are heuristic, not calibrated probabilities or financial advice.


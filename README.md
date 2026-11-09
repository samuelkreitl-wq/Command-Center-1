# Command-Center-1

System of record for Money OS / Kalshi short-window desk.

## Money OS Desk

See [`money-os-desk/`](./money-os-desk/) for the BTC15 lock, paper practice log, and the spoken-order desk.

The spoken desk reads a price and a **close** time in America/New_York (`1:15` is the 1:00–1:15 window, ticker suffix `0115-15`). It sketches a scenario, then waits for **Yes, place this order**. The server keeps a 60-second one-time proposal. `TRADING_ENABLED` defaults off. `KALSHI_ENV` defaults to `demo` (`https://demo-api.kalshi.co`). A paper book runs in the same process and cannot sign or send an order.

## Deploy on Replit (Reserved VM)

Deploy **this branch**. Do not merge it to `main` first. Autoscale is the wrong target: it sleeps. Use a Reserved VM so the paper loop stays up.

The repo is not deployed anywhere yet. A Reserved VM is what keeps the loop alive after this PR. The dev workflow (`npm run dev`) is not that host.

1. In Replit, open this repo and check out the branch for this PR.
2. Confirm `.replit` has `[deployment] deploymentTarget = "vm"`, `build = npm ci && npm run build`, and `run = node scripts/supervise.mjs`.
3. Secrets / environment (do not commit values):
   - `DATABASE_URL` — Replit Postgres, if the built-in database is attached. The process runs migrations on start. Without it, the desk stores the paper book in SQLite (`data/desk.sqlite`) or JSONL.
   - Leave `MODE` unset or set `MODE=PAPER`.
   - Leave `TRADING_ENABLED` unset or `false`.
   - Leave `KALSHI_ENV` unset or `demo`.
   - Do **not** set `KALSHI_API_KEY_ID` or `KALSHI_PRIVATE_KEY` until you intend to arm live orders. Live still requires `MODE=live` or `both`, `TRADING_ENABLED=true`, keys, and an explicit confirm. Paper never uses those keys.
4. Deploy as a **Reserved VM**. The process binds `0.0.0.0:$PORT`.
5. Check `GET /api/health` (`uptimeSec`, `lastHeartbeat`, `lastPollAt`, `feed` LIVE/STALE, `mode`, `traderRunning`) and `GET /api/paper/stats` plus `GET /api/paper/trades`.
6. `scripts/supervise.mjs` restarts the process if it exits non-zero. The paper loop also catches a bad tick and schedules the next one. A heartbeat is written every 5 seconds.

`npm start` is the production command. `npm run dev` is the Vite desk with the same API attached, for local work.

## Environment

See `.env.example`. Names only; never commit secrets.

| Name | Default | Role |
| --- | --- | --- |
| `MODE` | `PAPER` | `PAPER`, `LIVE`, or `BOTH`. The on-screen toggle is stored and overrides this until reset. |
| `TRADING_ENABLED` | false | Kill switch for real/demo orders. |
| `KALSHI_ENV` | `demo` | `demo` or `prod`. Public market reads stay on the elections API unless a test base is set. |
| `KALSHI_API_KEY_ID` | empty | Kalshi key id. |
| `KALSHI_PRIVATE_KEY` or `KALSHI_PRIVATE_KEY_PATH` | empty | PEM. RSA-PSS or Ed25519. |
| `MAX_CONTRACTS` / `MAX_ORDER_COST` | 10 / 10 | Per-order caps. |
| `PRICE_MOVE_TOLERANCE` | 0.02 | Refuse if the ask moves by more than this. |
| `PROPOSAL_TTL_MS` | 60000 | Confirm window. |
| `PAPER_POLL_MS` | 20000 | Paper loop. |
| `SHORT_HORIZON_REFRESH_MS` | 3600000 | 1/3/7 day scenario. |
| `DATABASE_URL` | empty | Postgres when set. |
| `DESK_STORE` | sqlite, else jsonl | `jsonl` forces the file log. |
| `SAFETY_*` | see `.env.example` | Watch and danger thresholds. |

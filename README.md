# Command-Center-1

System of record for Money OS / Kalshi short-window desk.

## Money OS Desk

See [`money-os-desk/`](./money-os-desk/) for the BTC15 lock, paper practice log, and the spoken-order desk.

The spoken desk reads a price and a **close** time in America/New_York (`1:15` is the 1:00–1:15 window, ticker suffix `0115-15`). It sketches a scenario, then waits for **Yes, place this order**. The server keeps a 60-second one-time proposal. `TRADING_ENABLED` defaults off. `KALSHI_ENV` defaults to `demo` (`https://demo-api.kalshi.co`). A paper book runs in the same process and cannot sign or send an order.

### Risk layer

A limit order rests until the market reaches it. A buy fills when the ask is at or below the limit, at that ask. A sell fills when the bid is at or above the limit, at that bid. Touching the limit fills. Trading through it fills. A quote that has not reached it leaves the order resting. Cancel, or the window close, ends it with no fill.

Live limits still pass the confirm gate. Nothing is placed without an explicit yes on that order. The optional limit on the spoken form overrides the ask; the gate still checks that the ask used to build the card has not moved.

A stop-loss is stored with the position. Set a percent of entry value, a dollar drop in position value (`count × (entry − bid)`), or both. If both are set, the first threshold reached exits. The confirm card states the stop. Confirming the entry pre-authorizes that exit, so the server can sell without a second prompt. With no stop on the card, confirming does not pre-authorize an exit.

Enforcement is server-side. The risk monitor (`RISK_POLL_MS`, default 10 seconds) re-marks open live positions against the live Kalshi bid and fires a pre-authorized stop even when no browser is open. The paper loop does the same for paper positions, using the same pure functions. A missing or stale quote (older than 30 seconds) never triggers a stop and never fills a limit. Every trigger is written to the journal with reason, price, and time. A live stop is sent only when `TRADING_ENABLED` is on, desk mode is `live` or `both`, and the order uses the configured host (`KALSHI_ENV=demo` unless you set `prod`). The paper book does not import the signer.

`POST /api/trade/cancel-resting` with `{ "orderId" }` cancels a resting live limit. `GET /api/learning/stats` is the learning readout below.

### Learning layer

Settled paper calls carry the forecast probability, entry price, timeframe readings (6M, 3M, 1W, 1D, 1H, and the minute tape), and conflict patterns such as `long-term up / minute down`. `GET /api/learning/stats` reports Laplace-smoothed hit rates (alpha 1) for the whole book, for each timeframe, and for each pattern. A timeframe or pattern needs 5 settled samples before its weight can move, and that weight stays inside ±0.25 of neutral. The spoken card and the paper trader show the raw scenario beside an adjusted probability. The adjustment is capped at ±8 percentage points. No trusted history leaves the raw probability unchanged. Each new paper settlement is part of the next read; there is no separate learning store.

### Recorded trade

On startup the desk appends, once, a manually recorded real entry: YES at 77 cents on Kalshi hourly BTC `$74,300 or above` (`KXBTCD-26NOV0902-T74299.99`), window ending 2:00 AM ET on 2026-11-09, forecast about 77% YES. Kalshi settled at $74,216.51, $83.48 below the strike. The call lost. `source` is `recorded`, not a paper-generated fill. Timeframe and conflict fields are reconstructed as unknown, so they stay in the overall accuracy tally and do not move a timeframe weight. It is returned by `GET /api/paper/trades` and counted in `GET /api/paper/stats`. Restarting does not insert a second copy.

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
| `PAPER_POLL_MS` | 20000 | Paper loop. The paper book applies the same limit and stop rules here. |
| `RISK_POLL_MS` | 10000 | Live limit and stop monitor. It does not send when trading is off. |
| `STOP_LOSS_PERCENT` | empty | Optional default stop, as a fraction (0.2 is 20%). The confirm card shows the stop that will be stored. |
| `STOP_LOSS_DOLLARS` | empty | Optional default dollar stop on position value. |
| `SHORT_HORIZON_REFRESH_MS` | 3600000 | 1/3/7 day scenario. |
| `DATABASE_URL` | empty | Postgres when set. |
| `DESK_STORE` | sqlite, else jsonl | `jsonl` forces the file log. |
| `SAFETY_*` | see `.env.example` | Watch and danger thresholds. |

# Outside activity / momentum bot panel

Added Nov 18, 2026 at Samuel's request: bring the Kalshi API key named `momentum-bot-btc15` under visibility in the Command Center. **Read-only. Nothing here trades, cancels, moves cash, pauses a bot, or touches an API key.**

## What it shows

New section **Outside / Momentum** (route `GET /api/desk/outside?hours=24|72|168`):

- Open positions, resting orders, orders, fills, settled markets and P&L for activity that did **not** come from this desk.
- Shard transfers with no `client_transfer_id` (this desk and Grok Bot always set one).
- A measured behavior fingerprint (market vs limit orders, fractional sizes, quick take-profit sells, same-second auto-funding, series mix).

How "outside" is decided: this desk always sends a `client_order_id`. Kalshi returns an **empty** `client_order_id` for the other activity. Kalshi does **not** say which API key placed an order, so the panel says "outside" (another key, the Kalshi app, or kalshi.com). If the momentum bot is ever found and given a tag, set `MOMENTUM_BOT_CLIENT_ORDER_PREFIX` and its orders show as `momentum-tag`.

Uses the existing `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY_PEM`. Signed GETs only (`server/outside.ts`); tests in `server/outside.test.ts` fail if a non-GET or an order/key path appears.

## What we know about the bot (Nov 18, 2026)

- Searched: all 16 Replit apps, 13 GitHub repos under `samuelkreitl-wq` (all branches of Command-Center-1), the one Lovable project, the one Vercel project, and the Grok Bot box. **No code named momentum-bot-btc15 and no code that sends live Kalshi orders other than this desk's password-gated Place bet.**
- `kalshi_btc15m_bot` (Replit + GitHub) is forecast/paper only: its notes say "Never add real order execution" and it has no order endpoint.
- Account fingerprint of the outside orders: market orders with a 99¢ cap (or 1¢ for sells), fractional dollar-sized counts (99.16, 13.79, 67.35, 105.62, 55.59), a sell limit placed 6–35 s after most buys, later cancelled or replaced, and a shard transfer with no `client_transfer_id` in the **same second** as the order. That pattern matches buying by dollar amount in the Kalshi app or website (which auto-funds the shard) as much as an API bot. It also includes ATP Challenger / ITF tennis, which a "btc15" bot would not trade.

## Pause control: design only, NOT implemented

There is no reachable bot code to pause, so nothing is wired. If the bot is found and it runs code Samuel controls:

1. The bot reads a pause flag every loop (`MOMENTUM_BOT_PAUSED=1`, or a row in its own DB) and stops opening new orders; it never auto-cancels.
2. The Command Center would get `POST /api/desk/outside/pause` that:
   - is disabled unless `MOMENTUM_PAUSE_CONTROL_ENABLED=1`;
   - requires `password` checked with `approvalPasswordOk(password, MONEY_DESK_APPROVAL_PASSWORD)` **and** a typed confirmation phrase in the same request;
   - is never reachable from a webhook, the scheduler, or the assistant (same rule as orders: `safety.test.ts` asserts it);
   - logs who/when/what to the order log; never logs the password.
3. Resume uses the same gate.

Account-level stop for an unknown client: the only lever is revoking that key in Kalshi → Settings → API keys. That is Samuel's manual decision; this code never calls `/api_keys`.

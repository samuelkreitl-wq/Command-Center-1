# Command-Center-1

Samuel's Command Center for the Kalshi desk. The hourly scanner, the BTC 15-minute desk, sports arbitrage, the assistant, and order placement all run in this app.

The BTC 15-minute rules and the paper desk live in [`money-os-desk/`](./money-os-desk/). The standing rules for picks are in [`docs/MONEY_DESK_PLAYBOOK.md`](./docs/MONEY_DESK_PLAYBOOK.md) (v1.4).

## Run

```bash
npm install
npm run dev
```

The process listens on `0.0.0.0:5000`. It serves the desk and runs the hourly scan on the hour in America/New_York, and once at boot if the last scan is older than 55 minutes. `npm start` serves the production build from `dist/` after `npm run build`. `npm test` runs the unit tests. `npm run scan` runs one live scan and prints a summary.

Paper trades stay in the browser. A live Kalshi order is sent only from Place bet, after that exact trade is confirmed and the approval password matches.

## Environment variables

Read from the environment. Do not commit values. Names:

| Name | Used for |
| --- | --- |
| `KALSHI_API_KEY_ID` | Kalshi access key id. Required to place an order or read shard cash. |
| `KALSHI_PRIVATE_KEY_PEM` | PEM private key for RSA-PSS SHA-256 signing. Required to place an order. |
| `MONEY_DESK_APPROVAL_PASSWORD` | Approval password. Compared in constant time. Missing or wrong rejects the order. |
| `XAI_API_KEY` | xAI chat completions. The assistant shows a needs-key state without it. |
| `XAI_MODEL` | Optional model name. Defaults to `grok-4`. |
| `ODDS_API_KEY` | The Odds API. Sports arbitrage shows a needs-key state without it. |
| `WEATHER_COMPANY_API_KEY` | Optional Weather Company daily forecast. Without it that source is marked unreachable. |
| `MONEY_DESK_ASSUMED_BANKROLL` | Optional dollars used only to illustrate quarter Kelly when shard cash cannot be read. |
| `MONEY_DESK_DATA_DIR` | Optional directory for the pick log and the order log. |
| `KALSHI_API_BASE` | Optional API origin override. |

A template with empty values is in [`.env.example`](./.env.example). The real `.env` is gitignored. Nothing in this repo places an order on its own: the hourly job and the assistant cannot call the order endpoint.

## Replit

`.replit` runs `npm run dev`, which keeps the Node process up so the hourly scanner runs on a Reserved VM. This change does not deploy.

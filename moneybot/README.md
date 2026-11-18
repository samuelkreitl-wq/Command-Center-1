# moneybot — Kalshi + Polymarket value-model pick engine (read-only)

**This package never places, changes or cancels orders, never moves money, and never prints secrets.**
It produces proposals. The existing routines (auto-buy at $5 or less, the exit monitor) and Samuel's approvals stay in charge of trading.

## Commands (run from `/home/box/shared/money-desk`)
```
python3 -m moneybot scan      [--cats weather,crypto,commodities,sports] [--venues kalshi,polymarket] [--bankroll 100] [--no-log] [--json]
python3 -m moneybot parlays   [--rescan] [--venues kalshi] [--include-watch] [--n 5]
python3 -m moneybot settle    # fetch results and settlement values (Kalshi expiration_value, Polymarket closed outcomes)
python3 -m moneybot backfill  # import hourly/picks-log.csv rows that carry a fair_prob
python3 -m moneybot calibrate # Brier, reliability, value MAE -> data/calibration.json (used by the next scan)
python3 -m moneybot report    # read-only positions monitor (pnl/dumps/latest.json + public quotes; Polymarket via POLYMARKET_WALLET)
python3 -m moneybot.test_moneybot
```

## Core idea: forecast the settlement value, then integrate
Every market is priced from a distribution of the value it settles on:
- **Weather (KXHIGH\*, Polymarket "highest temperature in …")**: daily high ~ N(mu, sd).
  - mu blends four sources: the NWS hourly peak, the Open-Meteo multi-model mean (GFS, ECMWF, ICON, GEM), the WU/The Weather Company page high (counted twice, because it is Kalshi's settlement source), and the station's bias vs the NWS hourly forecast for the latest METAR hour.
  - The running METAR max (tenths °C, `tools/wx_obs.py`) is a hard floor.
  - sd shrinks as ~4 PM local passes and is floored at 0.7°F. Model spread is added in quadrature.
  - Band probabilities follow Kalshi's integer rules. B70.5 means 70–71, integrated over 69.5–71.5. T62 "greater" means 63 or above. The observed max can kill a band or lock it in.
- **Crypto / commodities**: the settle price is lognormal around spot with zero drift. sigma comes from realized vol (Coinbase 5-minute bars over 24 h for crypto, Yahoo hourly bars over 10 days for metals and WTI), times sqrt(time to settle), times a 1.15 fat-tail factor.
  - Spot: Coinbase/Kraken mid for crypto, Pyth XAU/XAG (Kalshi's gold and silver source), and Yahoo CLF27 for WTI (Jan-27 contract, per the rules).
- **Sports**: DraftKings moneyline from the ESPN scoreboard JSON, with the vig removed. Games with no line are marked no-edge. Live games are skipped.

Each pick prints, for example, `predicted high 71.3±1.2F vs band 70-71 -> P(YES)=0.78`.

## Edge, sizing, verdicts (playbook §1.3–1.5)
- **Edge (¢/contract)** = 100·(fair − ask) − fee at the planned size.
  - Kalshi fee: ceil(0.07·C·P·(1−P)), rounded up per order.
  - Polymarket fee: rate·P·(1−P), using the market's `feeSchedule`.
- **Stake**: quarter Kelly on the bankroll you pass in (default $100), capped by the displayed depth.
- **PASS** needs all of the following:
  - edge ≥ 2¢ and ≥ 3% of price
  - depth at the ask
  - |fair − market| ≤ 15 pts and |raw model − market| ≤ 30 pts
  - edge < 25¢ (anything larger is treated as a data error)
- **WATCH** means positive edge that fails one of those checks.

## Learning loop
- `data/ledger_predictions.csv` records every priced market: its first estimate per ticker per day, plus pred_mu and pred_sd.
- `data/ledger_picks.csv` records every PASS pick and parlay leg.
- `settle` fills in the result, the outcome, and the actual settlement value.
- `calibrate` writes, per category:
  - Brier and log loss for the model vs the market mid
  - reliability buckets
  - a ridge-shrunk logistic recalibration (a, b)
  - a model/market blend weight w, shrunk toward 0.5
- The correction switches on only after 8 or more distinct events, because same-event rows are correlated.
- Per station or asset, it tracks MAE, bias and z-RMS of the value forecast. These feed back as a mu shift (temperatures only) and an sd scale.

## Parlays and venues
- Parlays use 2–4 PASS legs, at most one per correlation group:
  - one per NWS time-zone band for weather
  - all crypto counts as one group
  - metals and energy are separate groups
  - one leg per game
- Combined fair = product of the leg probabilities. Market-implied combo price = product of the leg asks. Each parlay also shows the most to pay for a combo quote.
- Kalshi combos trade on shard 1 (KXMVECROSSCATEGORY). Polymarket has no native parlays, so a mixed-venue parlay can only be placed as separate tickets.
- Cross-venue matching covers the same city, date and band, or the same ESPN game id. It flags `arb`, `near-arb` (same station, different source) and `basis-only` (different stations, e.g. Kalshi KMDW vs Polymarket KORD for Chicago).

## Secrets and env
- `POLYMARKET_WALLET`: optional. Enables read-only positions from data-api.polymarket.com.
- `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYMARKET_PASSPHRASE`: optional. The code only checks that they exist. It never uses them for orders and never prints them.
- Kalshi authenticated reads stay with the Replit kalshi_btc15m_bot signer. This package uses only public endpoints.
- Outputs go only to `moneybot/data/`, never to `outbox/` or `hourly/`, so nothing here can trigger an auto-buy routine.

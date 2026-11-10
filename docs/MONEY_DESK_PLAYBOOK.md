# Money Desk Playbook

How Samuel's money bot, sports-arbitrage tool and reality checker judge a bet before he ever sees it.
Version 1.0, Nov 10, 2026. The shared folder and record format are in `/home/box/shared/money-desk/README.md` and `money-desk.schema.json`.

---

## 0. Samuel's standing rules (they apply to everything below)

1. **Never auto-bet.** No bot, script, routine or paper trader places, cancels or changes an order by itself. That includes the BTC15 desk and the paper trader.
2. **Every trade needs Samuel's explicit yes, for that specific trade** (market, side, size, price). A yes to one order doesn't carry over to another. Shard transfers need their own yes too.
3. **A 15-minute window's time means its END time.** "The 4:15 window" runs 4:00 to 4:15 ET.
4. **Use Kalshi's official strike only.** Copy the strike and ticker exactly as the API gives them (e.g. `T74249.99`, a target of `74179.25`). Never round them or restate them from a screenshot.
5. **Be honest about what wasn't verified.** Anything stale, assumed or model-only goes in `unverified[]` and is said out loud.
6. **Tooling spend stays around $10 a month or less** without asking. That covers odds APIs, servers and paid data. Free tiers come first.
7. **Never print API keys or private keys.** Say where a key lives, never what it is.
8. **If an order fails, report the exact error.** Don't retry it on a different market.
9. **Don't touch positions Samuel has told us to leave alone,** and don't merge PRs or push to `main` without his yes.

---

## 1. Shared math

### 1.1 Odds to implied probability
- **American odds:** for a favorite with negative odds A, p = −A / (−A + 100). For an underdog with positive odds A, p = 100 / (A + 100).
- **Decimal odds:** p = 1 / d. To go from decimal to American: if d ≥ 2, A = 100·(d − 1); if d < 2, A = −100 / (d − 1).
- **Kalshi:** the ask is the price of the contract in dollars, so a 63¢ ask is p = 0.63 before fees.

### 1.2 Removing the bookmaker's cut ("vig")
A two-way market's implied probabilities add up to more than 1, and the extra is the bookmaker's cut. Take it out before comparing.
- **Multiplicative:** pᵢ' = pᵢ / Σp. This is simple, but it overstates longshots.
- **Power method (preferred):** find k such that Σ pᵢᵏ = 1, then pᵢ' = pᵢᵏ. It handles the favorite-longshot bias better.
- **Report both, and treat the lower one as fair.** For a +2000 longshot the two can differ by 2–3 points. That gap is model error, not edge.
- **Sharp vs soft books:** prefer a sharp book (Pinnacle, Circa) or the consensus across several books as the fair price. A single soft book is the weakest source.

### 1.3 Kalshi taker fee
fee = ceil_to_cent(0.07 × C × P × (1 − P)), where C is the number of contracts and P is the price in dollars. The fee is rounded up **per order**, so small orders pay more per contract. One contract at 39¢ costs 2¢ in fees, but 10 contracts cost 17¢, which is 1.7¢ each. Check the market's own fee schedule, because some series differ, and resting maker orders can cost less.

### 1.4 Edge
- **Edge per contract (¢) = 100 × (fair_prob − ask) − fee per contract (¢).**
- **The edge counts only if it beats the model error.** Run at least two model variants, for example several volatility windows or both vig methods, and use the worst-case edge. If the edge is positive in only one variant, it's a WATCH at best.

### 1.5 Kalshi cash lives on separate shards
Each shard holds its own cash. Shard 0 is general (weather, economics, NHL, NFL), shard 1 is combos, shard 2 is crypto and commodities, and shard 3 is sports (NBA, college games, tennis, baseball). Check every market's `exchange_index`.

API orders don't move cash between shards. An empty shard returns `insufficient_balance`. A transfer is `POST /portfolio/intra_exchange_instance_transfer` and needs Samuel's yes. Every record lists `cash_needed_on_shard`, plus the transfer it would take.

---

## 2. Sports arbitrage evaluation

### 2.1 When an arb exists
A set of mutually exclusive, exhaustive outcomes is an arb when the **best available price** for each outcome, across venues, gives

  **S = Σᵢ (1 / dᵢ) < 1**, where dᵢ is the decimal odds after fees.

- **Kalshi as a venue:** buying YES at ask P with fee f per contract pays $1 for P + f, so its effective decimal odds are d = 1 / (P + f).
- **Sportsbooks:** use the decimal odds of the price you can actually get, not the headline number.
- **Guaranteed return:** (1/S − 1). This is the arb's edge in percent.

### 2.2 Minimum threshold
- **Net return after every fee must be at least 1.5%,** using worst-case rounding. Anything under that is FAIL. Small arbs get eaten by slippage, voids and limits.
- **If any leg is 3-way** (soccer, or hockey in regulation), every outcome must be covered. A 2-way Kalshi market against a 3-way book line is **not** an arb, because the draw breaks it.

### 2.3 Stake sizing (2-way, and n-way in general)
To make the payout equal whichever outcome wins, with a total stake T:

  **stakeᵢ = T × (1/dᵢ) / S**, and every outcome then pays T / S.

- **Kalshi legs:** contracts = floor(stakeᵢ / (P + f)). Recompute with the fee for that order size, which is rounded per order, and re-check that S < 1 after rounding.
- **Sportsbook legs:** round to the book's minimum unit, then recompute the payouts. Note the gap between the worst and best payouts.
- **Cap per arb:** the smallest of $25, 10% of the cash across the venues involved, or the smallest leg's known limit. Start at $5–10 a leg until a venue's fills and settlement have been seen working.

### 2.4 Kill-checks before an arb is PASS
- **Settlement rules match exactly.** Overtime and extra innings count? Push or void rules? What happens if a game is postponed, or the starting pitcher or player changes? Kalshi may settle at "last fair price" if an event is cancelled. Any mismatch means FAIL, or price the void.
- **Line staleness.** Every quote is less than 60 seconds old for live markets, or less than 5 minutes for pre-game, with a time stamp on each. The Odds API's free tier marks lines stale after 15 minutes. Treat anything older than 5 minutes as stale.
- **Limits and fillability.** Depth at the Kalshi ask is at least the planned contracts. The sportsbook limit is known, or assumed small. Plan the order: fill the thin or fast leg first.
- **Account risk.** Sportsbooks limit accounts that bet arbs. Note it, and don't hide it.
- **Shard cash** is in place for every Kalshi leg. Otherwise write down the transfer, but don't do it.
- **Same-game or correlated legs** don't count as an arb unless they are truly exhaustive.

### 2.5 +EV picks that aren't arbs
- **Fair probability** comes from a no-vig sharp price, or from a model: a realized-vol lognormal model for crypto, forecast blends against the settlement station for weather.
- **Kelly fraction for a binary contract bought at P:** f* = (p − P) / (1 − P).
- **Stake = ¼ × f* × bankroll on that shard** (quarter Kelly), with these hard caps:
  - **Per pick:** the smaller of $5 or 5% of the shard's cash.
  - **Per day:** across all picks, the smaller of $15 or 25% of total cash.
  - **Below threshold:** never bet if the worst-case edge after fees is under 2¢ per contract, or under 3% of the price.
- **Parlays:** multiply the leg probabilities **only for truly independent legs.** Crypto legs move together, and so do same-game legs. Use a correlation haircut (Cutline uses 12% on same-game legs) or price the combo directly. Kalshi combos sit on shard 1 and are priced through an RFQ, which is a write that needs approval. Compare the RFQ quote with the product of the fair probabilities, not with the product of the asks.

---

## 3. Reality check

Run this on every arb or pick before it reaches Samuel. Answer each question in `reasons[]` or `unverified[]`.

| # | Question | FAIL if |
|---|---|---|
| 1 | **Settlement source and rules:** Does the market's rules text (`rules_primary` and `rules_secondary`) match what we priced? Kalshi weather uses The Weather Company or the CLI station, not the NWS point forecast. Crypto uses the CF Benchmarks BRTI 60-second average. Is the strike the official one? | Mismatch, or the rules weren't read |
| 2 | **Data freshness:** Is every input time-stamped (`data_timestamps`)? Is anything older than 5 minutes, or 60 seconds for live markets? | Any key input is stale or has no time stamp |
| 3 | **Liquidity:** Is there enough depth at the ask for the planned size? Is the spread 3¢ or less? Was the book seen at least twice? | Not enough depth, or spread over 5¢ |
| 4 | **Correlation:** Does this overlap Samuel's open positions or other picks (same asset or game, same direction)? | It doubles exposure he didn't ask for |
| 5 | **Model error:** Is the edge positive in the worst-case variant? Does it beat the gap between model variants? | Positive in only one variant (that makes it WATCH) |
| 6 | **Fees:** Are fees in, at the planned order size and rounded per order? | The edge disappears after fees |
| 7 | **What would make it wrong?** Name the one scenario that loses: a CPI print, a lineup change, a sea breeze, a settlement quirk. | No answer |
| 8 | **Base rates:** Does a 95% favorite really win 95% of the time at this spread or cushion? Where does the market's implied distribution have fatter tails? | Fair probability is above the base rate with no reason |
| 9 | **News since the price was set:** injuries, scheduled data releases (CPI, Fed), weather model updates, exchange outages. | Material news we haven't priced |
| 10 | **Time to close:** Is there enough time to get Samuel's yes and fill the order? | Closes before a yes is realistic, under about 5 minutes |
| 11 | **Cash and shard:** Is there cash on the right shard, or a written transfer plan? Has the balance been verified this session? | Unknown, without saying so |
| 12 | **Rules check:** No auto-bet, Samuel's explicit yes needed, official strike, 15-minute window = end time. | Any breach |

**Verdict**
- **PASS:** no FAIL rows, the worst-case edge clears the threshold, and depth is fine. The record goes to Samuel as a proposal.
- **WATCH:** close, or it depends on a trigger (a price level, after a data release, after a fresh pull). Set `watch_trigger` and `expires_at`.
- **FAIL:** any FAIL row. Keep the record for learning, but never pitch it.

Write the result to `inbox/reality-check/…` with `reviewed_by` pointing at the record it reviewed.

---

## 4. Output format

Every arb, pick and review is **one JSON record that matches `money-desk.schema.json`**, saved under the naming rule in the README. Each record also carries a **3-line human summary**, in this order:

1. **What:** market, side, price, size and cost.
2. **Why:** fair probability and its source, and edge after fees.
3. **Risk:** what loses, what wasn't verified, and the verdict.

When a summary is read aloud to Samuel, use those three lines plus the closing time in ET and "needs your yes".

---

## 5. Daily loop (money bot)

1. Pull live data and write candidate records to `outbox/`.
2. Pick up new `inbox/arbitrage/` records.
3. Run the reality check on each and write it to `inbox/reality-check/`.
4. Re-pull prices for the PASS records, and for WATCH records whose trigger has hit. Then present each one to Samuel with "needs your yes".
5. Only after he says yes to a specific trade: place exactly that trade, then report the order ID, fill, fees and balance.
6. Move expired records to `archive/YYYY-MM-DD/`. Log the results so the model learns how well its picks were calibrated: Brier score, and hit rate by bucket.

## 6. Known sources (as of Nov 10, 2026)

- **Cutline:** the sports-arbitrage and parlay tool, in private repo `samuelkreitl-wq/quiet-dune-wood-otter`.
  - Open PR #1 (not a draft) adds The Odds API feed (free tier 500 credits a month, needs `ODDS_API_KEY`).
  - It never places bets and isn't deployed.
  - It's the natural writer for `inbox/arbitrage/`.
- **Reality check:** a review Samuel asked the Creation bot for, not yet a skill. The Money OS build prompt also has a "Scoreboard (the reality check)" spec: it shows a "no edge proven yet" banner until at least 20 settled paper markets are positive after costs.
- **Kalshi API:** `https://api.elections.kalshi.com/trade-api/v2`. Public GETs need no key. Authenticated calls go through the `kalshi_btc15m_bot` Replit app's signing helper. As of Nov 10, 7:24 AM ET, that returned 401 `INCORRECT_API_KEY_SIGNATURE`, so the key needs fixing.
- **Other data:**
  - **Prices:** Kraken and Coinbase public tickers.
  - **Sportsbook lines:** ESPN scoreboard JSON, which carries DraftKings moneylines.
  - **Weather:** NWS `api.weather.gov` forecasts and observations, and Open-Meteo model blends.

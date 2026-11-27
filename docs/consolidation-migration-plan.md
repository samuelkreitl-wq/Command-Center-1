# Consolidation recommendations for other apps

Written recommendation only. Underdog, Fliff, Rebet, Doghouse Casino, and DraftKings are not part of this Command Center and are not added to the Money Bot UI or API. Polymarket stays the keyless scan-only surface already on the Money Bot desk. Nothing here places a bet, opens an account, or requests an API key.

The AlfonzoCore control-plane plan is [alfonzocore-migration-plan.md](./alfonzocore-migration-plan.md).

## Underdog

- **What would move.** A normalized scan card only: contest name, side, posted price, and a suggested-pick note next to the Command Center stake floor. An exposure line could later record a stake Samuel already logged by hand. An alert badge could mark a stale price.
- **What would stay separate.** Account login, location checks, contest entry, and any checkout stay in the Underdog app. Command Center would not hold a session or submit an entry.
- **What risks orphaning.** A standalone slate scraper or a private odds sheet would stop matching the app if the contest names change. A manual bet log kept outside the desk would no longer tie to the card. Promo credit and bonus balances live on the account, not in a scan file, and would read as zero if someone treated the scan as the wallet.

## Fliff

- **What would move.** A scan card with the posted side, price, and a plain-English suggestion, plus a badge when the quote is stale. A later ledger line could record coins Samuel already used, copied from his own note, not from a Fliff session.
- **What would stay separate.** Login, sweepstakes-coin play, purchase flows, and redemption stay in the Fliff app. A scan card would not submit a pick or move coins.
- **What risks orphaning.** Sweepstakes coin balances and promo grants are account state. A scraper that reads the social feed can break when the app renames a market. A manual pick log that is not the same file as the scan would be left behind. Fliff is not a sportsbook checkout this desk can call.

## Rebet

- **What would move.** The same shape as the other scan cards: market title, side, price, and a suggestion badge. A hand-entered exposure note could sit beside it later. No Rebet client is added now.
- **What would stay separate.** Rebet account auth, social or sweepstakes play, and any in-app checkout stay on Rebet. Platform rules for what counts as a pick stay on that app.
- **What risks orphaning.** A one-off odds script pointed at Rebet's pages will orphan the moment the markup changes. Manual bet notes and sweepstakes coin balances are not in this repo. Copying a balance into Command Center without the account session would show a number the app no longer honors.

## Doghouse Casino

Doghouse Casino is Snoop Dogg's sweepstakes casino app. It is not a prediction-market venue and it is not wired into this desk.

- **What would move.** At most a status card: app name, whether a public promo is listed, and a badge Samuel set by hand. Not a game feed, and not a suggested wager.
- **What would stay separate.** Play, wallet, KYC, and sweepstakes coin purchase or redemption stay inside Doghouse Casino. Command Center would not open a game or hold a session.
- **What risks orphaning.** Coin and promo balances exist only on the account. A manual log of play sessions would be orphaned if the app name or the sweepstakes rules change and the note still points at an old screen. There is no odds slug to normalize. Do not invent a scraper for casino games.

## DraftKings

This repo already compares some sportsbook prices through The Odds API for the sports-arb panel. That panel is not a DraftKings product, and this recommendation does not add one.

- **What would move.** A normalized suggested-pick card: event, side, American or decimal price, and the edge note the arb panel already knows how to show. A later exposure line could record a stake Samuel typed himself.
- **What would stay separate.** DraftKings login, deposits, bet placement, DFS contest entry, and state-by-state sportsbook rules stay on DraftKings. Command Center does not get a DraftKings session.
- **What risks orphaning.** The sportsbook quote depends on a third-party odds feed (`ODDS_API_KEY` in this repo). If that feed drops DraftKings, the card goes stale and must say so. A private scraper or a manual bet log outside the desk would no longer match the feed. Promo balances and bonus bets are account state and would be wrong if read from a scan file.

## Polymarket

Polymarket is the one name in this list that the Money Bot section already shows. It stays scan-only.

- **What would move.** What is already on the desk: price, spread, net edge against the dynamic bar, the quarter-Kelly stake against the selected floor, model warnings, and a clickable Polymarket link. Suggested picks remain visible for review. No further Polymarket product surface is added here.
- **What would stay separate.** Order entry, the CLOB client, funded wallets, and any signed order stay on Polymarket. Auto-execution stays parked. The badge on the desk is **Manual Review Only — Auto-Execution Parked**. Samuel opens the link and places the trade himself.
- **What risks orphaning.** Scanning is public and keyless. No Polymarket API key is required or requested. A missing or empty `clob_token_ids` list is scan-only and must not be indexed as if a token existed. US and international market slugs differ, so a link built for one host will 404 on the other. Keep the URL that arrived on the scan file. A third-party odds feed is not a substitute for that public market page. Deprecating a manual log of Polymarket fills would orphan the only record of trades this desk never sends.

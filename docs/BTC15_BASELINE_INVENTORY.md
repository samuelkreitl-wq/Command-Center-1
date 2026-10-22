# BTC15 baseline inventory

Step 1 only. This document records what is on the GitHub default branch and how that tree differs from the 2026-10-21 Replit snapshot. No application logic, UI, or behavior was changed. Nothing from the snapshot was imported.

Reviewed: 2026-10-22.

## 1. Baseline

| Item | Value |
|---|---|
| Repository | `samuelkreitl-wq/Command-Center-1` |
| Default branch | `main` (`origin/HEAD` → `origin/main`) |
| Tip | `a4e8002` — “Add Crypto Fear & Greed Index feed to Money OS Desk” |
| Tracked files | 16 |
| Desk location | `money-os-desk/` only |

`main` is a TypeScript library meant to be dropped into a host app. The root README says to wire a UI against `money-os-desk/src/lib/desk.ts`. There is no `package.json`, test suite, server, database, or React/HTML UI on this branch. The initial commit (`b6a9a47`) was only `README.md`. The Command Center application that runs on Replit has never been in this Git history.

History that produced the desk, oldest first:

| Commit | What it added |
|---|---|
| `9dab60c` | Phase 1+2 modules: lock, engine, paper, hard-stop, journal |
| `f4b8214` | Engine, journal, and desk facade |
| `f5342f7` | Live Kalshi + Kraken feeds |
| `5433db3` | Stake-rounding module (sports arb, not BTC15) |
| `909b322` | Static WNBA sports picks |
| `3eff060` / `fbf7ff4` | README notes for those two modules |
| `a4e8002` | Crypto Fear & Greed feed, attached to the snapshot but not to the score |

## 2. Replit snapshot vs GitHub

Source zip: `replit_command_center_1_snapshot_3272.zip` (uploaded with this task).

| Item | Value |
|---|---|
| App | Command Center (1), replId `c522f316-f342-4f20-9e67-57f01ad7dd33` |
| Replit `timeUpdated` | 2026-10-21T13:37:36.835Z (from the snapshot `MANIFEST.md`) |
| Saved files in the zip | 225 |
| Paths in common with GitHub `main` | **none** |

The snapshot is a different tree, not a dirty copy of `money-os-desk/`. A path intersection of the two trees is empty, including `README.md` (Replit has `replit.md` and `MANIFEST.md`, not the GitHub README). There is therefore no file that exists in both places with different contents. The comparison below is presence-only.

Not in the zip, so absence here is not proof they are absent on Replit: `pnpm-lock.yaml`, `*.tsbuildinfo`, SQLite `-shm` / `-wal` (row data), and Replit Secrets. The manifest says no `.env` files and no hard-coded secrets were in the saved text. Schema SQL is in the saved source; database rows are not.

### 2.1 GitHub only (do not treat as already on Replit)

The entire desk, and only the desk:

| Path | Note |
|---|---|
| `README.md` | Points operators at `desk.ts`. Not in the snapshot. |
| `money-os-desk/README.md` | Phase 1+2 module map and feed example. |
| `money-os-desk/src/lib/types.ts` | Desk contracts. `Direction` is `"UP" \| "DOWN"` only. |
| `money-os-desk/src/lib/engine.ts` | RSI / EMA / VWAP score and the live call. |
| `money-os-desk/src/lib/kraken.ts` | Public Kraken **spot** REST (`api.kraken.com`, pair `XBTUSD`). |
| `money-os-desk/src/lib/kalshi.ts` | Public Kalshi `KXBTC15M` markets and orderbook. |
| `money-os-desk/src/lib/fear-greed.ts` | alternative.me Fear & Greed. |
| `money-os-desk/src/lib/feeds.ts` | Poll loop that builds a desk snapshot. |
| `money-os-desk/src/lib/desk.ts` | Facade: snapshot, lock, paper, settle. |
| `money-os-desk/src/lib/signal-lock.ts` | First-write-wins core lock and settlement. |
| `money-os-desk/src/lib/journal.ts` | `localStorage` lock, trade, and custom-ref store. |
| `money-os-desk/src/lib/paper.ts` | Paper YES/NO fills. Not sent to Kalshi. |
| `money-os-desk/src/lib/hard-stop.ts` | Cooldown after a missed lock. |
| `money-os-desk/src/lib/stake-rounding.ts` | Sportsbook stake jitter. Not on the BTC call path. |
| `money-os-desk/src/lib/stake-rounding.example.ts` | Example caller for stake rounding. |
| `money-os-desk/src/lib/sports-picks.ts` | Static WNBA picks. Not BTC. |

### 2.2 Replit only — meaningful (not imported)

These are the snapshot files that actually do work. About 110 of the 225 saved files are duplicated shadcn `components/ui/*` copies under `artifacts/command-center` and `artifacts/mockup-sandbox`. Those, plus `tsconfig` / `package.json` / `.replit` / generated Orval clients, are scaffolding. They are not listed row by row.

**Kraken Futures paper terminal.** This is the only live market UI in the snapshot. It is not the KXBTC15M desk. It reads `https://futures.kraken.com/derivatives/api/v3/tickers`, stores perpetuals in SQLite, and paper-fills at the mark. It has no Kalshi client, no strike, no RSI/EMA/VWAP, and no UP/DOWN call.

| Path | Role |
|---|---|
| `artifacts/api-server/src/lib/adapters.ts` | `KrakenFuturesAdapter.fetchMarkets`, `PaperExecutionAdapter.executeMarketOrder`. |
| `artifacts/api-server/src/lib/trading-engine.ts` | Paper orders, DCA/grid bots, webhooks. `MarketFreshness = "live" \| "stale" \| "unavailable"`. `refreshMarkets`. `getMarketPrice` refuses a quote older than 45s. |
| `artifacts/api-server/src/lib/trading-db.ts` | SQLite tables on the shared `command-center.sqlite` file: markets, ticks, accounts, orders, positions, bots, webhooks, executions, `trading_event_log`. |
| `artifacts/api-server/src/routes/trading.ts` | `GET /trading/snapshot`, `GET /trading/markets`, paper order/bot/position routes. Orders and bots are rejected unless freshness is `"live"`. |
| `artifacts/command-center/src/TradingTerminal.tsx` | Futures terminal. Badge text is `LIVE · KRAKEN FUTURES`, `STALE · LAST LIVE QUOTE`, or `LIVE FEED UNAVAILABLE`. Includes a **paper** account strip (label, status, `PAPER` badge), not a Kalshi account. |
| `artifacts/command-center/src/trading-terminal.css` | Styles for that terminal. |

**Command Center shell and platform store.** Project names mention Kalshi and Money OS. They are seed labels, not market integrations. `command-center.ts` repeats the same seed list for the API.

| Path | Role |
|---|---|
| `artifacts/command-center/src/App.tsx` | Shell. View `"trading"` renders `TradingTerminal`. `localStorage` keys `cc-projects`, `cc-activity`, `cc-platform-state`, `cc-active-system`. Activity export is named `command-center-ledger.json` (a JSON download of UI activity, not a BTC decision ledger). Seed project `kalshi-capitalizer` is a static card. |
| `artifacts/command-center/src/components/command-center-ui.tsx` | Shell chrome: status pill, page header, loading/error/empty. |
| `artifacts/api-server/src/routes/command-center.ts` | Projects, activity, resources, integrations over Postgres/Drizzle when `DATABASE_URL` is set. Same seed data, including `kalshi-capitalizer`. |
| `artifacts/api-server/src/routes/platform.ts` | System-builder API. Reports `storage: "sqlite"`. |
| `artifacts/api-server/src/lib/platform-db.ts` | SQLite schema: systems, entities, fields, records, views, dashboards, `change_log`, `app_settings`. File default `artifacts/api-server/.data/command-center.sqlite`. |
| `lib/db/src/schema/projects.ts` | Postgres `command_center_projects` table. Not trading state. |
| `artifacts/mockup-sandbox/` | Separate Vite preview app. No market data. |

**Notes and pasted prompts, not runtime:**

| Path | Role |
|---|---|
| `MANIFEST.md` | Backup manifest for this snapshot (counts, exclusions, secret-name scan). |
| `replit.md` | Generic Replit stack notes. Product sections are still placeholders. |
| `.agents/memory/*.md` | Agent memory notes (portable system builder, perpetual terminal, offline command center). |
| `attached_assets/Pasted-*.txt` | Pasted design prompts. Not executed code. |

### 2.3 What this means for the desk

The BTC15 library on GitHub and the running Replit app do not share an implementation. Replit already has three things the spec also asks for, but for a different product: a freshness enum (`live` / `stale` / `unavailable`), server-side SQLite authority for that terminal, and a paper account strip. None of those are wired to Kraken spot last, a Kalshi strike, or an UP/DOWN/AT STRIKE call. They are listed so a later step does not reinvent the futures terminal or mistake it for Section 10.

## 3. File inventory (GitHub `main`)

Categories match the task: (a) produces a BTC call or decision, (b) stores state, (c) renders the desk UI, (d) fetches market data. A file can sit in more than one category. Line numbers refer to `main` at `a4e8002`.

### 3.1 (a) Call and decision

| Path | Key exports | Note |
|---|---|---|
| `money-os-desk/src/lib/engine.ts` | `runEngine`, `leanVsLevel`, plus internal `rsi`, `ema`, `vwap` | Builds a numeric score from strike distance, RSI(7), EMA9/21, and 15-bar VWAP. `call` is `UP` when `score >= 0`, else `DOWN`. |
| `money-os-desk/src/lib/desk.ts` | `buildSnapshot`, `lockFromLive`, `placePaper`, `settleWindow`, `setCustomReference`, `listJournal`, `listTradeLog` | `liveCall` is `engine.call`. Hard-stop can replace `action` with `NO_TRADE` without changing the call. |
| `money-os-desk/src/lib/signal-lock.ts` | `windowId`, `lockCore`, `updateScalp`, `requestOverride`, `settleCore` | First lock for a window is kept. Settlement outcome is `endPx >= strike → UP`. `requestOverride` returns an event and does not store it. |
| `money-os-desk/src/lib/paper.ts` | `openPaperTrade`, `settlePaperTrade` | Paper YES/NO at the contract ask. Settlement uses the strike, not the custom ref. |
| `money-os-desk/src/lib/hard-stop.ts` | `evaluateHardStop`, `cooldownForMarket` | After a miss, blocks new paper size and forces snapshot action to `NO_TRADE` for 15 minutes (5 minutes on a 5m market). |
| `money-os-desk/src/lib/types.ts` | `Direction`, `SignalAction`, `DeskSnapshot`, `CoreLock`, `PaperTrade` | `Direction` has no `AT STRIKE`. Actions are `NO_TRADE`, `WATCH`, `LEAN_YES`, `LEAN_NO`. |
| `money-os-desk/src/lib/feeds.ts` | `pollDeskFeeds`, `startFeedLoop` | Calls `buildSnapshot` every poll. Does not lock, settle, or roll a window on its own. |

### 3.2 (b) Persistence

All desk persistence is browser `localStorage`. If `localStorage` is missing, reads return empty and writes no-op (`journal.ts` lines 9–11, 23–25). There is no database, file store, or server on `main`.

| Path | Keys / behavior | Note |
|---|---|---|
| `money-os-desk/src/lib/journal.ts` | `moneyos.btc.journal.v1`, `moneyos.btc.trades.v1`, `moneyos.btc.customRef` | `loadLocks` / `saveLocks`, `appendLock`, `settleLocksForWindow`, `loadTrades` / `saveTrades`, `appendTrade`, `settleTradesForWindow`, `loadCustomRef` / `saveCustomRef`, `evidenceStats`. |
| `money-os-desk/src/lib/desk.ts` | calls the journal | `lockFromLive` and `placePaper` write through the journal. `settleWindow` rewrites settled rows in place. |

`appendLock` inserts only when that `windowId` is new (`journal.ts` lines 28–37). Settlement then replaces the stored object (`settleLocksForWindow`, lines 40–50). `saveLocks` / `saveTrades` write the whole array back. That is a mutable blob, not an append-only ledger. Override events from `requestOverride` are not persisted. Scalp state is computed and then stored as `scalp: null` on the snapshot (`desk.ts` line 81).

### 3.3 (c) Desk UI

No file on `main` renders a desk. There is no component, stylesheet, route, or HTML page. `money-os-desk/README.md` tells a host app to import `startFeedLoop` and read `b.snapshot`. The Section 10 screen, risk card, and account strip are not present.

The Replit snapshot’s `TradingTerminal.tsx` is a UI, and it is Replit-only. It renders a Kraken Futures paper terminal, not a BTC15 strike desk. See section 2.2.

### 3.4 (d) Market data

| Path | Key exports | Note |
|---|---|---|
| `money-os-desk/src/lib/kraken.ts` | `fetchKrakenSpot`, `fetchKrakenOhlc1m`, `pollKraken`, `krakenTickerSubscribeMsg`, `krakenOhlcSubscribeMsg` | Public REST only. Spot last comes from `Ticker?pair=XBTUSD` field `c[0]`. `ts` is `Date.now()` at parse time, not an exchange timestamp. OHLC interval is 1 minute; volume is column index 6. WebSocket helpers are exported and unused by `feeds.ts`. |
| `money-os-desk/src/lib/kalshi.ts` | `fetchOpenMarkets`, `fetchActive15mContract`, `fetchActiveContract`, `fetchOrderbookAsks`, `enrichContractQuotes`, `fetchPublicTrades`, `mapMarketToContract` | Public `https://api.elections.kalshi.com/trade-api/v2`. No auth header. Series `KXBTC15M`. `SERIES_5M` is `null`. Strike is `floor_strike`. Active contract is the open market with the earliest `close_time` and a positive strike. |
| `money-os-desk/src/lib/fear-greed.ts` | `fetchFearGreed` | Public `https://api.alternative.me/fng/?limit=8`. Current, yesterday, and index 7 (“last week”). |
| `money-os-desk/src/lib/feeds.ts` | `pollDeskFeeds`, `startFeedLoop` | `Promise.allSettled` of Kalshi, Kraken, and Fear & Greed. Failures become `errors[]`. The snapshot is still built from whatever succeeded. Default poll is 8 seconds. |

No other venue is fetched on `main`. Kalshi account, balance, and position endpoints are not called.

### 3.5 In the same folder, not on the BTC15 path

| Path | Key exports | Note |
|---|---|---|
| `money-os-desk/src/lib/stake-rounding.ts` | `roundStake`, `balanceTwoWayArb`, `DEFAULT_CONFIG` | Sportsbook two-way arb stake rounding and a residual-risk figure. Not used by `desk.ts` or `engine.ts`. |
| `money-os-desk/src/lib/stake-rounding.example.ts` | script-style example | Prints a sample `balanceTwoWayArb` result. |
| `money-os-desk/src/lib/sports-picks.ts` | `CURRENT_PICKS`, `getCurrentPicks` | Hard-coded WNBA card dated 2026-09-17. No fetch, no BTC. |

## 4. Claims check

The notes describe the GitHub desk. They were checked against `main` at `a4e8002`, not taken as given. The Replit app does not contain this code, so the claims are not a description of the snapshot.

| Claim | Verdict | Evidence |
|---|---|---|
| `kraken.ts` and `kalshi.ts` are public reads | **Confirmed** | `kraken.ts` lines 1–3 and 9–10: Kraken public REST, “No API key required.” `kalshi.ts` lines 1–9: “Kalshi public market data (no auth)” against the elections trade API. Neither file sends a key or a signed header. |
| Indicator math lives in `engine.ts` | **Confirmed** | `rsi` (lines 34–48, default period 7), `ema` (lines 50–58), `vwap` (lines 60–70). `runEngine` calls them as RSI(7), EMA 9, EMA 21, and VWAP of the last 15 bars (lines 98–123). |
| `runEngine` folds RSI, EMA, and VWAP into a score that becomes the call | **Confirmed** | Score starts at 0. Strike distance contributes ±1 (lines 90–96). RSI ±0.5 when ≥60 or ≤40 (lines 98–109). EMA9 vs EMA21 ±0.75 (lines 111–121). Price vs VWAP ±0.5 (lines 123–132). `call` is `score >= 0 ? "UP" : "DOWN"` (line 138). Indicators can therefore flip a call that the strike alone would not make. |
| `leanVsLevel` treats `price >= level` as UP | **Confirmed** | `engine.ts` lines 176–178: `return price >= level ? "UP" : "DOWN"`. Equality is UP. There is no third state. `desk.ts` lines 64–67 uses it for both the strike and the custom ref. Settlement uses the same `>=` rule (`signal-lock.ts` lines 84–87, `paper.ts` line 53). |
| Confidence is an invented 50–86 number that can change the action | **Partly true** | Formula, lines 139–140: `round(50 + min(\|score\|, 3) * 12)`. The cap of 3 would make 86, but the weights sum to at most 2.75, so the highest value this code can emit is 83. The value is 50 only when the other terms cancel the strike’s ±1 exactly. It does change the action: `p = confidence / 100` is compared with the ask (lines 145–161), and `LEAN_YES` / `LEAN_NO` also require `confidence >= 68`. Below that, with a quote, the action stays `WATCH` or becomes `NO_TRADE`. Hard-stop is a second action override, applied later in `buildSnapshot` (`desk.ts` lines 75–78), and it does not use this number. |
| Factors are a score list | **Confirmed** | `factors` is a `string[]` filled in the same blocks as the score (`engine.ts` lines 87–136). Entries are prose (“Above strike by …”, “RSI(7)=… firm”, “EMA9 > EMA21”). Two lines do not change the score: neutral RSI, and the “Late window” note. They are not tagged SUPPORTS or CONFLICTS, and they are not a numeric breakdown. |
| Storage is `localStorage` | **Confirmed** | `journal.ts` lines 5–11 and 13–26, 67–80, 100–111. Three keys, listed in section 3.2. No other desk store exists on `main`. |
| There is no verify gate | **Confirmed** for the desk | No `LIVE` / `STALE` / `NO DATA` symbol, and no age check before a call. `feeds.ts` records fetch failures on `errors` (lines 32–69) and still calls `buildSnapshot` (line 71). A spot tick with empty bars still produces a call from the strike term alone (`engine.ts` lines 79–81 and 90–96). Spot `ts` is set to `Date.now()` in `kraken.ts` line 47 and is never compared to a limit. The Replit futures terminal has a different freshness gate (section 2.2). It is not in this repo and it does not gate a BTC15 call. |
| There is no automatic 15-minute window roll | **Partly true** | Nothing schedules a roll on the quarter hour, and the feed never calls `settleWindow` or `lockFromLive`. What does exist: every poll, `fetchActive15mContract` (`kalshi.ts` lines 76–82) re-reads open `KXBTC15M` markets and returns the soonest close. `startFeedLoop` repeats that every 8 seconds by default (`feeds.ts` lines 85–91). The selected contract can change when Kalshi’s open set changes. Prior-window locks and paper trades stay unsettled until some caller invokes `settleWindow`. |
| There is no Section 10 screen | **Confirmed** | No UI files on `main`. The Replit `TradingTerminal` is a futures blotter, not a BTC15 LIVE screen. |
| There is no risk card | **Confirmed** for BTC15 | No position-size or contract-risk calculator is called from the desk. `placePaper` takes a caller-supplied `size` (`desk.ts` lines 116–135). `stake-rounding.ts` computes sportsbook residual risk and is not referenced by the desk. |
| There is no account strip | **Confirmed** for Kalshi | `kalshi.ts` has markets, orderbook, and public trades only. No balance, portfolio, or account request. No UI strip on `main`. The Replit terminal’s account strip is a local paper futures account. |
| There is no ledger | **Partly true** | There is no append-only observation/decision ledger. There is a mutable `localStorage` journal of core locks and paper trades (`journal.ts`). Rows are rewritten on settle. `requestOverride` is not stored. `evidenceStats` (`journal.ts` lines 53–65) is a win/loss count with a default target of 20, not a ledger. |

## 5. Spec gap map

“Today” means GitHub `main` at `a4e8002`, because that is the baseline. Replit-only cousins are noted in the evidence column and are not counted as present.

| Spec requirement | Status | What exists |
|---|---|---|
| Strike-only primary call: UP / DOWN / AT STRIKE from live Kraken BTC last vs the active Kalshi strike | **Partial** | Kraken last and Kalshi `floor_strike` are both fetched, and `leanVsStrike` compares them (`desk.ts` lines 64–65, `engine.ts` lines 176–178). The field the desk treats as the call is `liveCall`, which is the scored `runEngine` result (`desk.ts` line 73, `engine.ts` line 138), so RSI/EMA/VWAP can override the strike. `Direction` is only `"UP" \| "DOWN"` (`types.ts` line 3). Price equal to the strike is UP, not AT STRIKE. |
| RSI(7), EMA9/21, VWAP, and volume as SUPPORTS / CONFLICTS evidence only | **Partial** | RSI(7), EMA9, EMA21, and VWAP are implemented and then added into the score that sets `call` and `confidence` (`engine.ts` lines 98–140). They are not evidence tags. Volume is stored on each 1m bar (`kraken.ts` line 78) and used only as the VWAP weight (`engine.ts` lines 64–68). There is no standalone volume factor and no SUPPORTS / CONFLICTS vocabulary. |
| LIVE / STALE / NO DATA verify gate | **Missing** | Desk path has fetch `errors[]` only (`feeds.ts` lines 26–69) and will still emit a call from partial inputs. No quote-age gate. Replit’s futures engine uses `live` / `stale` / `unavailable` and a 45s cutoff (`trading-engine.ts` `getMarketPrice` and `refreshMarkets`). That gate is a different feed, and it is not in this repo. |
| Automatic 15-minute window roll | **Partial** | Polling re-selects the earliest open `KXBTC15M` contract (`kalshi.ts` lines 62–82, `feeds.ts` lines 85–97). There is no boundary clock, no roll event, and no automatic settle of the window that just closed. |
| Backend authority instead of browser `localStorage` | **Missing** | Desk locks, trades, and the custom reference are `localStorage` (`journal.ts`). `main` has no server. Replit SQLite/Postgres authority covers the futures terminal and the command-center shell, and that app also still mirrors shell state to `localStorage` (`App.tsx`). It does not store this desk. |
| Section 10 BTC15 LIVE screen | **Missing** | No screen on `main`. Replit `TradingTerminal.tsx` is a Kraken Futures paper terminal. |
| Separate risk calculator | **Missing** | No BTC15 risk card. `stake-rounding.ts` is an unrelated sportsbook helper and is not wired to the desk. |
| Read-only Kalshi account strip | **Missing** | Public market reads only (`kalshi.ts`). No authenticated account endpoint and no strip. Replit’s strip is a paper futures account (`TradingTerminal.tsx`). |
| Append-only observation / decision ledger | **Missing** | Closest artifact is the mutable lock/trade journal in section 3.2. Settlement rewrites rows. Observations, indicator evidence, verify-gate results, and override events are not appended. Replit `trading_event_log` and the activity export named `command-center-ledger.json` are futures/platform logs, not this ledger. |

## 6. Call path as it actually runs

One poll of `pollDeskFeeds("15m")`:

1. Fetch the earliest open `KXBTC15M` market, then best-effort replace its asks from the orderbook (`feeds.ts` lines 32–46, `kalshi.ts` `enrichContractQuotes`).
2. Fetch Kraken spot last and 1m OHLC (`kraken.ts` `pollKraken`).
3. Fetch Fear & Greed and attach it to the snapshot. `runEngine` never reads it.
4. `buildSnapshot` runs `runEngine` when a contract exists. The returned `call` becomes `liveCall`. `leanVsStrike` is computed separately and can disagree with `liveCall`.
5. If the latest settled lock was a miss and the cooldown has not elapsed, `action` becomes `NO_TRADE`. `liveCall` is left as the engine call.
6. Nothing in the loop locks the core, opens paper, or settles the previous window. Those happen only if a caller uses `lockFromLive`, `placePaper`, or `settleWindow`.

`runEngine` returns `null` when the strike is missing, or when both the spot and the bar list are missing (`engine.ts` lines 78–79). In that case `liveCall` is `null`, `confidence` is 0, and `action` is `WATCH` unless hard-stop is active (`desk.ts` lines 73–78). A live spot with no bars is enough to emit UP or DOWN from the strike term alone, at confidence 62 (`|score| = 1` → `50 + 12`).

# AGENTS.md — Money OS Desk / Command-Center-1

## What this repo is

`money-os-desk/src/lib` is a **TypeScript library** meant to be dropped into a host app
(Command Center / Replit). There is no application, UI, server, database, or test suite
in the library itself — see `docs/BTC15_BASELINE_INVENTORY.md` for the full baseline.

To make the library visible in the Base44 preview, this repo adds the minimum needed to
run it: `package.json`, `tsconfig.json`, and a read-only dev harness in `dev/`.

## Running it in the Base44 sandbox

```bash
docker compose -f docker-compose.base44.yml up -d
```

- `dev/server.ts` runs the library's own `startFeedLoop` (market 15m, poll every 8s) and
  serves the latest bundle: the page at `/` and the raw JSON at `/api/snapshot`.
- Host port **3000** is the preview entry point. `node:22` + bind mount + `tsx watch`,
  so editing `dev/server.ts` or `money-os-desk/src/lib/*.ts` restarts the server with no
  image rebuild; `dev/index.html` is re-read from disk on every request.
- Dependencies install at container start (`npm ci` when `package-lock.json` is present,
  else `npm install`) into the `desk-node-modules` named volume, so `node_modules` never
  lands in the checkout.

## Things that are not obvious

- **No credentials are required.** All three feeds are public and key-free: Kraken REST
  (`kraken.ts`), Kalshi trade API `KXBTC15M` (`kalshi.ts`), alternative.me Fear & Greed
  (`fear-greed.ts`). `.base44/environment.json` therefore lists no secrets, and there is
  no `/run/base44/app.env` wiring.
- **The harness is read-only, deliberately.** `journal.ts` is `localStorage`-backed, so
  inside Node it returns empty arrays: the desk's lock/paper/journal features are inert
  and the page shows `0 settled locks` / `evidence —`. Locking and paper trades only work
  in a browser host that provides `localStorage`; wiring those up would mean moving
  journaling server-side, which is product work, not setup.
- **Feeds are fetched server-side** by the harness on purpose, so no browser CORS
  dependency (Kalshi's public API is the risk). `pollDeskFeeds` records per-feed failures
  in `errors[]` and still builds a snapshot from partial data — the page surfaces those
  errors under "Feed errors", which is the first thing to check when something looks off.
- **Kalshi strikes come from `floor_strike`** on the newest open market for
  `KXBTC15M`; `SERIES_5M` is `null` until Kalshi lists a 5m series, so `MARKET=5m`
  yields no contract.
- `BASE44_PREVIEW_MODE` is passed through to the service as a bare env entry, but no code
  currently gates on it — the harness is plain `node:http` with no host/origin allowlist
  to widen.

## Verifying it works

```bash
# container health (probes both the page and the snapshot API)
docker compose -f docker-compose.base44.yml ps

# live bundle: errors should be [], with a contract strike + Kraken spot
curl -fsS http://localhost:3000/api/snapshot | head -c 400

# types
docker compose -f docker-compose.base44.yml exec -T desk npx tsc --noEmit
```

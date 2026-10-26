# Threat Model

## Project Overview

Money OS / Command Center is a **client-only** React 19 + TypeScript + Vite single-page
application ("BTC research desk"). It displays Bitcoin short-window (15-minute) market
context by reading **public, unauthenticated** market data from Kraken and Kalshi, and
lets the user record paper (simulated) directional calls and trades. There is **no real
order execution, no real money, no server-side application logic, no database, and no
user accounts or authentication**.

Tech stack:
- React 19 + Vite 6 SPA served from `money-os-desk/`.
- `npm run dev` = Vite dev server; `npm start` = `vite preview` serving `dist/` on port 5000.
- The only server component is Vite's built-in reverse proxy, which forwards two fixed
  same-origin paths to public upstreams:
  - `/api/kraken` → `https://api.kraken.com/0/public`
  - `/api/kalshi` → `https://api.elections.kalshi.com/trade-api/v2`
- All user state (journal of locked calls, paper trades, custom reference price) is stored
  only in the browser's `localStorage`. Nothing is synced or persisted server-side.

Deployment: currently **not deployed** (`isDeployed: false`).

## Assets

- **Browser-local research records** — journal of "locked" directional calls and paper
  trades in `localStorage`. These are low-sensitivity, per-browser, non-PII practice
  records. Loss/clearing is expected behavior; there is no confidential data.
- **No high-value assets** — there are no credentials, API keys, secrets, sessions,
  payment data, PII, or multi-user data in this project. The proxied upstreams are public
  and require no authentication.

## Trust Boundaries

- **Browser → Vite proxy → public APIs**: the only network boundary. The proxy targets
  are hardcoded to Kraken and Kalshi public endpoints; arbitrary targets are not accepted
  (no user-controlled proxy destination). Upstream data is untrusted but is coerced to
  numbers/strings and rendered through React (auto-escaped).
- **External feed → client rendering**: Kalshi/Kraken responses are attacker-influenceable
  only by compromising those upstreams. All numeric fields pass through `Number(...)` with
  `Number.isFinite` guards; string fields (e.g. `ticker`) are rendered as React text nodes,
  which are HTML-escaped. No `dangerouslySetInnerHTML`, `eval`, `new Function`, or
  `innerHTML` usage exists.
- **localStorage → app state**: parsed with `JSON.parse` inside try/catch. This data is
  controlled by the same user/origin, so it is not a cross-user trust boundary.

## Scan Anchors

- Production entry points: `money-os-desk/src/App.tsx` (UI), `money-os-desk/src/lib/feeds.ts`
  (feed orchestration), `vite.config.ts` (proxy + server config).
- Network/data-fetch code: `money-os-desk/src/lib/kraken.ts`, `money-os-desk/src/lib/kalshi.ts`.
- Persistence: `money-os-desk/src/lib/journal.ts` (localStorage only).
- Pure computation (no external surface): `engine.ts`, `desk.ts`, `paper.ts`,
  `signal-lock.ts`, `hard-stop.ts`, `types.ts`.
- Dev-only / ignore unless proven reachable: `tests/`, `*.test.ts`, `.local/skills/**`
  (auth templates under `.local/skills/*` are skill scaffolding, NOT part of this app).

## Threat Categories

### Information Disclosure
There are no server-side secrets, credentials, or PII in the app or in client bundles.
The two proxy upstreams are public and unauthenticated, so the proxy does not expose
anything an attacker could not fetch directly. No meaningful disclosure risk.

### Tampering
Paper trades, locks, and the custom reference live in `localStorage` and are fully under
the local user's control by design; there is no integrity boundary to protect (single-user,
non-authoritative practice records). Upstream feed tampering would require compromising
Kraken/Kalshi and would only affect displayed numbers, not code execution (values are
numeric-coerced and React-escaped).

### Spoofing / Elevation of Privilege
Not applicable: no authentication, authorization, roles, tenants, or privileged actions
exist. There are no access-control decisions to get wrong.

### Security Misconfiguration
The Vite server/preview config sets `allowedHosts: true`, disabling Host-header
validation. See the recorded LOW finding; impact is minimal here because the server only
serves static assets and proxies to public APIs (no sensitive local resources).

### Guarantees to uphold going forward
- The proxy MUST keep hardcoded upstream targets; never introduce a user-controlled proxy
  destination (would create SSRF).
- Feed-derived values MUST continue to be numeric-coerced/validated and rendered as React
  text; never introduce `dangerouslySetInnerHTML` with feed/localStorage data.
- If authentication, a backend, a database, or real order execution is ever added, this
  threat model MUST be revisited from scratch — the current "no high-value assets"
  assumption would no longer hold.

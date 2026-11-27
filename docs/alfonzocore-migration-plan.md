# AlfonzoCore → Command Center

Written plan only. This document does not merge repositories, delete AlfonzoCore, copy its build, or place an order.

AlfonzoCore (`samuelkreitl-wq/AlfonzoCore`) is what Command Center started as. Its `PROJECTS.md` calls that repo the Command Center. Command-Center-1 is the Kalshi money desk that now holds the same control-plane job. One registry and one shell is enough. The October note in `COMMAND_CENTER_PLAN.md` still says not to delete anything. Follow that until the checks below are done by hand.

Companion recommendations for other apps, which stay out of this codebase, are in [consolidation-migration-plan.md](./consolidation-migration-plan.md).

## What moves

Move the control plane, not the organs.

- **Shared orchestration.** The routing rule in AlfonzoCore `PROJECTS.md` (intent, then domain, then organ) and the classifier in `src/lib/alfonzoEngine.ts`. In Command Center this is a read-only label for where a request belongs. It does not run a trade, a deploy, or a music export.
- **Control-plane UI.** The shell in `src/Shell.tsx` and the status of the existing cards (Finance, Coding, Project, Sophia, Music). Show status. Do not turn those cards into live connectors.
- **Project registry and status.** `PROJECTS.md` together with `src/lib/projects.ts`: id, domain, organ, status, optional URL, notes. Command Center becomes the list. The Replit row stays `needs_url` until a real App URL is pasted. Do not invent one.
- **Core agent routing.** The spiral labels in `src/lib/s3.ts` and `src/lib/construct.ts`, as a description of how a request is classified. Sophia, the Kalshi review, and music stay pointers to the places they already live.

The Kalshi desk already in `money-os-desk/` stays here. Do not port it back into AlfonzoCore.

## What stays

Leave these where they are, or archive them. Do not fold them into the money desk.

- **AlfonzoCore's own build and deploy.** `bun.lock`, `vite.config.ts`, Tailwind, ESLint, the Vercel project `alfonzo-core`, and the Onspace homepage. Command Center keeps its Node and Vite desk build.
- **Blink as a standalone client.** `src/blink/client.ts` and `blink-tagger.plugin.mjs`. Do not import that client into this repo.
- **Historical specs and sample state.** `S3.md`, `CONSTRUCT.md`, `BTC15_MVP_BLUEPRINT.md`, and the boot log, goals, and card metrics in `src/constants/alfonzoData.ts`. Those metrics are samples, not balances.
- **The public near-duplicate, if it is still published.** `COMMAND_CENTER_PLAN.md` names `alfonzcore` next to AlfonzoCore. Do not delete either repo from this plan.
- **Organs that were never the desk.** Music, books, Notion, broker accounts, and Replit-as-a-builder. The October plan already keeps those separate.

## What risks orphaning

Do these checks before AlfonzoCore is treated as deprecated. This plan does not perform them.

- **Blink key wiring.** `src/blink/client.ts` reads `VITE_BLINK_PROJECT_ID` and `VITE_BLINK_PUBLISHABLE_KEY`, and it also falls back to literals in source. Before any copy, delete the literals, rotate the publishable key in Blink, and keep the replacement only in an uncommitted env file. This repository must not gain a Blink client, and this document does not repeat the key. Leave Blink in AlfonzoCore until that file no longer contains a fallback secret and a person has confirmed the env-only client still loads.
- **`PROJECTS.md` references.** The markdown registry and `src/lib/projects.ts` can drift, and `bindReplit` mutates the in-memory list. Diff both lists and keep AlfonzoCore's copies until Command Center names the same ids: `alfonzo-core`, `replit-command`, `onspace`, `money-os`, `kalshi-bot`, `sophia`, `music`, `books`.
- **Replit and GitHub links.** `PROJECTS.md` says the Replit Command Center still needs a URL. `projects.ts` marks `replit-command` as `needs_url`. The GitHub remote is `samuelkreitl-wq/AlfonzoCore`. The published skin is Vercel project `alfonzo-core`. Write those pointers into the Command Center registry before the old repo is archived. Do not guess a Replit URL.
- **Hardcoded URLs and sub-app pointers.** The repo homepage is `https://onspace.ai`. Card tool lists in `alfonzoData.ts` name Kalshi, Polymarket, IBKR, Ableton, and Notion. Sample finance figures in that file are not live balances. Link the desk to Command-Center-1. Leave Polymarket as the keyless scan already on this desk. Do not follow a hardcoded URL into an order.
- **Turning the old deployment off too early.** Archiving the GitHub repo first would leave Vercel `alfonzo-core` on a stale skin or an empty project. Point that project at Command Center, or leave the old deployment up, until every registry link still resolves. Do not delete the GitHub repo in the same step as a UI move.

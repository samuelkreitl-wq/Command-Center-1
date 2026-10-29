# S3 command center — consolidation plan

Exported 2026-10-29. This is a plan, not a merged app.
Do not delete repos, Notion pages, or the money-os-desk modules.

## Goal

One screen that shows status and links into the apps that already exist.
The apps stay where they are. v1 does not merge codebases or place live orders.

## What exists (checked on GitHub)

| App | State |
| --- | --- |
| AlfonzoCore (private) and alfonzcore (public) | Near-duplicate Vite apps. Pick one later. Do not merge yet. |
| Command-Center-1/money-os-desk | Real paper-desk modules: paper, hard-stop, journal, engine, kalshi, kraken, feeds, desk. Journal is localStorage. |
| kalshi_btc15m_bot | Empty except .gitignore and LICENSE. Not the bot. |
| Notion Money OS / BTC 15M log | Memory. Last known paper count was 0/20. |
| tastytrade | Docs only. No client in this repo. |

## Recommended approach

A thin command center: links plus one status panel.
Do not rebuild Alfonzo, Money OS, music apps, and brokers into one application.

Keep separate: broker accounts, Notion (until a file log exists), music apps, drives.

## v1 done when

1. Home shows paper-cycle count from a file that survives refresh (not only localStorage).
2. Home links to this repo's money-os-desk, the Notion paper log, and one Alfonzo repo.
3. There is no live-order button and no broker secret in the page.

## Phases

0. Freeze. Do not delete anything. Name which Alfonzo repo is primary.
1. Leave money-os-desk as the trading logic. Do not rewrite it.
2. Add a file or SQLite write beside localStorage. Keep the old journal until the file is verified.
3. Add a Home page that only reads that file and shows links.
4. Optional: copy the same row into Notion after the file write succeeds.
5. Only then add music or other links.

## Still needed from Samuel

1. Command center v1 is for you alone — yes or no.
2. Primary Alfonzo repo — AlfonzoCore or alfonzcore.
3. Week-one workflows — confirm: paper status, Notion, one Alfonzo link.

## Replit

This file was committed to GitHub because Replit is not connected from the chat.
In the existing Replit project (Command-Center-1): use the Git pane and pull main,
or create a new Repl via Import from GitHub: samuelkreitl-wq/Command-Center-1.

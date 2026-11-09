import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store";

test("paper events survive a new store on the same file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-jsonl-"));
  const first = await openStore({ driver: "jsonl", path: dir });
  await first.appendPaper({ kind: "missed", ts: 10, ticker: "ABC", reason: "down" });
  await first.close();
  const second = await openStore({ driver: "jsonl", path: dir });
  const rows = await second.paperRows();
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { ticker: string }).ticker, "ABC");
  await second.close();
});

test("sqlite migrations can be opened twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-sqlite-"));
  const path = join(dir, "desk.sqlite");
  const first = await openStore({ driver: "sqlite", path });
  await first.appendPaper({ kind: "entry", ts: 1, ticker: "T", id: "e" });
  await first.setKv("desk-mode", "paper");
  await first.close();
  const second = await openStore({ driver: "sqlite", path });
  assert.equal((await second.paperRows()).length, 1);
  assert.equal(await second.getKv("desk-mode"), "paper");
  await second.close();
});

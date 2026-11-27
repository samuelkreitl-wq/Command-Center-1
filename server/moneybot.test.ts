import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { handleApi } from "./index.js";
import { handleMoneybot, resolveSettingsPath, SHARED_SETTINGS_PATH, type MoneybotDeps } from "./moneybot.js";
import { CLOB_TOKEN_WARNING, evaluatePick, POLYMARKET_KEYLESS_NOTE, readClobTokenIds, readHourly } from "./moneybot-picks.js";

const ALLOWED = [1, 5, 10, 15, 20, 25];

function envIn(dir: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    MONEYBOT_SETTINGS_PATH: path.join(dir, "runtime_settings.json"),
    MONEYBOT_SCANS_DIR: path.join(dir, "scans"),
    MONEYBOT_DRY_RUN_LOG: path.join(dir, "dry-runs.jsonl"),
    ...extra,
  };
}

async function withApi(env: Record<string, string | undefined>, fn: (base: string) => Promise<void>, deps: MoneybotDeps = {}) {
  const server: Server = createServer(async (req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/api/moneybot")) {
      await handleMoneybot(req, res, env, deps);
      return;
    }
    if (url.startsWith("/api/desk")) {
      await handleApi(req, res, env);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function post(base: string, pathname: string, body: unknown) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, json };
}

test("stake floor accepts each allowed value, rejects the rest, and defaults to $5", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneybot-floor-"));
  const env = envIn(dir);
  try {
    await withApi(env, async (base) => {
      const first = await fetch(`${base}/api/moneybot/floor`);
      const opened = await first.json() as { min_stake_usd: number; source: string };
      assert.equal(first.status, 200);
      assert.equal(opened.min_stake_usd, 5);
      assert.equal(opened.source, "default");
      assert.equal(existsSync(env.MONEYBOT_SETTINGS_PATH!), false);

      for (const floor of ALLOWED) {
        const saved = await post(base, "/api/moneybot/floor", { min_stake_usd: floor });
        assert.equal(saved.status, 200);
        assert.equal(saved.json.min_stake_usd, floor);
        const again = await fetch(`${base}/api/moneybot/floor`);
        const body = await again.json() as { min_stake_usd: number; source: string };
        assert.equal(body.min_stake_usd, floor);
        assert.equal(body.source, "file");
      }

      const file = JSON.parse(readFileSync(env.MONEYBOT_SETTINGS_PATH!, "utf8")) as { min_stake_usd: number; updated_at: string };
      assert.equal(file.min_stake_usd, 25);
      assert.equal(Number.isNaN(Date.parse(file.updated_at)), false);

      for (const bad of [0, 2, 7, 30, 5.5, -1, "5", null, true, [], {}]) {
        const rejected = await post(base, "/api/moneybot/floor", { min_stake_usd: bad });
        assert.equal(rejected.status, 400);
        assert.match(String(rejected.json.error), /1, 5, 10, 15, 20, 25/);
      }
      const still = JSON.parse(readFileSync(env.MONEYBOT_SETTINGS_PATH!, "utf8")) as { min_stake_usd: number };
      assert.equal(still.min_stake_usd, 25);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a valid MONEYBOT_MIN_STAKE_USD override wins and an invalid one is ignored", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneybot-env-"));
  try {
    writeFileSync(path.join(dir, "runtime_settings.json"), JSON.stringify({ min_stake_usd: 5, updated_at: "2026-11-01T00:00:00.000Z", mode: "paper" }));
    await withApi(envIn(dir, { MONEYBOT_MIN_STAKE_USD: "10" }), async (base) => {
      const res = await fetch(`${base}/api/moneybot/floor`);
      const body = await res.json() as { min_stake_usd: number; source: string; persisted_min_stake_usd: number };
      assert.equal(body.min_stake_usd, 10);
      assert.equal(body.source, "env");
      assert.equal(body.persisted_min_stake_usd, 5);
      const status = await fetch(`${base}/api/desk/status`);
      const desk = await status.json() as { min_stake_usd: number };
      assert.equal(desk.min_stake_usd, 10);
    });
    await withApi(envIn(dir, { MONEYBOT_MIN_STAKE_USD: "7" }), async (base) => {
      const body = await (await fetch(`${base}/api/moneybot/floor`)).json() as { min_stake_usd: number; source: string };
      assert.equal(body.min_stake_usd, 5);
      assert.equal(body.source, "file");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings path uses the explicit file, then the shared directory, then the local fallback", () => {
  assert.equal(resolveSettingsPath({ MONEYBOT_SETTINGS_PATH: "  /tmp/floor.json  " }), "/tmp/floor.json");
  assert.equal(resolveSettingsPath({}, () => true), SHARED_SETTINGS_PATH);
  assert.equal(resolveSettingsPath({}, () => false), path.join(process.cwd(), "data", "runtime_settings.json"));
});

test("hourly picks label a sample when no scan exists and do not bump under the floor", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneybot-sample-"));
  try {
    await withApi(envIn(dir), async (base) => {
      const body = await (await fetch(`${base}/api/moneybot/hourly`)).json() as {
        sample: boolean;
        label: string;
        polymarket_scan: string;
        polymarket_keyless_note: string;
        picks: Array<Record<string, unknown>>;
      };
      assert.equal(body.sample, true);
      assert.match(body.label, /Sample fallback/);
      assert.equal(body.polymarket_scan, "keyless");
      assert.equal(body.polymarket_keyless_note, POLYMARKET_KEYLESS_NOTE);
      const low = body.picks.find((pick) => pick.id === "sample-btc-round");
      assert.ok(low);
      assert.equal(low.quarter_kelly_usd, 2);
      assert.equal(low.floor_usd, 5);
      assert.equal(low.verdict, "SKIP");
      assert.equal(low.eligible, false);
      assert.match(String(low.reason), /Strict no-bumping/);
      const poly = body.picks.find((pick) => pick.id === "sample-poly");
      assert.ok(poly);
      assert.equal(poly.manual_only, true);
      assert.equal(poly.eligible, false);
      assert.equal(poly.scan_only, true);
      assert.equal(poly.keyless, true);
      assert.deepEqual(poly.clob_token_ids, []);
      assert.equal(poly.spread, 0.03);
      assert.match(String(poly.url), /^https:\/\/polymarket\.com\//);
      assert.ok((poly.warnings as string[]).includes(CLOB_TOKEN_WARNING));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live scan feeds hourly picks and the market selector, including a Polymarket row", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneybot-live-"));
  const scans = path.join(dir, "scans");
  mkdirSync(scans);
  writeFileSync(path.join(scans, "latest.json"), JSON.stringify({
    finishedAt: "2026-11-27T12:00:00.000Z",
    pass: [{
      id: "kxhigh-nyc",
      market: { title: "NYC high above 72", ticker: "KXHIGHNY-72" },
      side: "YES",
      price: 0.41,
      fair_prob: 0.57,
      edge: { cents_per_contract_after_fees: 9.5 },
      stake_suggestion: { cost_dollars: 15, contracts: 30, max_loss_dollars: 15 },
      verdict: "PASS",
      venues: [{ venue: "kalshi", url: "https://kalshi.com/markets/kxhighny-72", side: "YES", price: 0.41 }],
      unverified: ["Weather Company forecast was not checked."],
    }],
    watch: [{
      id: "poly-watch",
      title: "Will the sample election market resolve yes",
      ticker: "POLY-TURN",
      side: "YES",
      price: 0.48,
      spread: 0.02,
      fair_prob: 0.62,
      net_edge_cents: 7,
      quarter_kelly_usd: 11,
      verdict: "PASS",
      venue: "polymarket",
      url: "https://polymarket.com/event/sample-election",
      warnings: ["Public book only."],
    }],
  }));
  try {
    await withApi(envIn(dir), async (base) => {
      const hourly = await (await fetch(`${base}/api/moneybot/hourly`)).json() as {
        sample: boolean;
        picks: Array<{ id: string; venue: string | null }>;
        catalog: Array<{ id: string }>;
      };
      assert.equal(hourly.sample, false);
      assert.ok(hourly.picks.some((pick) => pick.id === "kxhigh-nyc"));
      assert.ok(hourly.picks.some((pick) => pick.id === "poly-watch" && pick.venue === "polymarket"));
      assert.ok(hourly.catalog.some((row) => row.id === "poly-watch"));
      const suggestion = await (await fetch(`${base}/api/moneybot/suggest?q=KXHIGHNY-72`)).json() as { pick: { id: string; eligible: boolean; plain: string } };
      assert.equal(suggestion.pick.id, "kxhigh-nyc");
      assert.equal(suggestion.pick.eligible, true);
      assert.match(suggestion.pick.plain, /Net edge/);
      const missing = await fetch(`${base}/api/moneybot/suggest?q=not-a-market`);
      assert.equal(missing.status, 404);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run records a Kalshi pick and never calls live execution", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneybot-dry-"));
  let calls = 0;
  try {
    await withApi(envIn(dir), async (base) => {
      const saved = await post(base, "/api/moneybot/dry-run-order", { id: "sample-nyc-high" });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.confirmation, "Dry Run Recorded");
      assert.equal(saved.json.live, false);
      assert.equal(saved.json.executed, false);
      assert.equal(calls, 0);
      const log = readFileSync(path.join(dir, "dry-runs.jsonl"), "utf8");
      assert.match(log, /Dry Run Recorded/);
      assert.equal(/portfolio\/events\/orders|placeConfirmedOrder/.test(log), false);
      const live = await post(base, "/api/moneybot/dry-run-order", { id: "sample-nyc-high", live: true });
      assert.equal(live.status, 403);
      assert.match(String(live.json.error), /Nothing was sent/);
      assert.equal(calls, 0);
    }, { liveProbe: () => { calls += 1; } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Polymarket auto-placement is rejected and empty CLOB token lists do not throw", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneybot-poly-"));
  const scans = path.join(dir, "scans");
  mkdirSync(scans);
  writeFileSync(path.join(scans, "latest.json"), JSON.stringify({
    picks: [
      { id: "poly-missing", title: "Missing tokens", venue: "polymarket", side: "YES", price: 0.4, fair_prob: 0.6, net_edge_cents: 10, quarter_kelly_usd: 12, url: "https://polymarket.com/event/missing-tokens" },
      { id: "poly-empty", title: "Empty tokens", venue: "polymarket", side: "NO", price: 0.44, fair_prob: 0.6, net_edge_cents: 9, quarter_kelly_usd: 12, clob_token_ids: [], url: "https://polymarket.com/event/empty-tokens" },
      { id: "poly-bad", title: "Bad tokens", venue: "polymarket", side: "YES", price: 0.41, fair_prob: 0.58, net_edge_cents: 8, quarter_kelly_usd: 12, clob_token_ids: "not-a-list", url: "https://polymarket.com/event/bad-tokens" },
      { id: "poly-ok", title: "Has tokens", venue: "polymarket", side: "YES", price: 0.4, fair_prob: 0.6, net_edge_cents: 10, quarter_kelly_usd: 12, clob_token_ids: [" token-a ", "", null, 3], url: "https://polymarket.com/event/has-tokens", warnings: ["Model is a proxy."] },
    ],
  }));
  let calls = 0;
  try {
    const hourly = readHourly(envIn(dir));
    for (const id of ["poly-missing", "poly-empty", "poly-bad"]) {
      const pick = hourly.picks.find((row) => row.id === id);
      assert.ok(pick);
      assert.deepEqual(pick.clob_token_ids, []);
      assert.equal(pick.scan_only, true);
      assert.equal(pick.eligible, false);
      assert.ok(pick.warnings.includes(CLOB_TOKEN_WARNING));
    }
    const kept = hourly.picks.find((row) => row.id === "poly-ok");
    assert.ok(kept);
    assert.deepEqual(kept.clob_token_ids, ["token-a"]);
    assert.equal(kept.warnings.includes(CLOB_TOKEN_WARNING), false);
    assert.equal(kept.eligible, false);
    assert.equal(evaluatePick({ title: "Kalshi row", side: "YES", price: 0.4, net_edge_cents: 10, quarter_kelly_usd: 12, clob_token_ids: [] }, 5, false).scan_only, false);

    await withApi(envIn(dir), async (base) => {
      for (const body of [
        { id: "poly-ok" },
        { id: "poly-missing", auto: true },
        { venue: "polymarket", url: "https://polymarket.com/event/has-tokens", live: true },
      ]) {
        const rejected = await post(base, "/api/moneybot/dry-run-order", body);
        assert.equal(rejected.status, 403);
        assert.equal(rejected.json.live, false);
        assert.equal(rejected.json.executed, false);
        assert.equal(rejected.json.auto_execution, "parked");
        assert.match(String(rejected.json.error), /Manual Review Only — Auto-Execution Parked/);
      }
      assert.equal(calls, 0);
      assert.equal(existsSync(path.join(dir, "dry-runs.jsonl")), false);
    }, { liveProbe: () => { calls += 1; } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("money bot source does not call the live order path or request a Polymarket key", () => {
  for (const name of ["moneybot.ts", "moneybot-picks.ts", "moneybot-settings.ts"]) {
    const src = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.equal(/placeConfirmedOrder|signedKalshi|portfolio\/events\/orders|POLYMARKET_API_KEY|clob_token_ids\[0\]/.test(src), false);
  }
  assert.deepEqual(readClobTokenIds(undefined).ids, []);
  assert.deepEqual(readClobTokenIds(null).ids, []);
  assert.equal(readClobTokenIds({ 0: "nope" }).empty, true);
});

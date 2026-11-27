import type { IncomingMessage, ServerResponse } from "node:http";
import { listDryRuns, readHourly, recordDryRun, suggestMarket, type LiveProbe } from "./moneybot-picks.js";
import {
  isAllowedStakeFloor,
  readStakeFloor,
  stakeFloorPayload,
  StakeFloorError,
  writeStakeFloor,
} from "./moneybot-settings.js";

export {
  ALLOWED_STAKE_FLOORS,
  DEFAULT_STAKE_FLOOR,
  STAKE_FLOOR_NOTE,
  SHARED_SETTINGS_DIR,
  SHARED_SETTINGS_PATH,
  StakeFloorError,
  envStakeFloor,
  isAllowedStakeFloor,
  readStakeFloor,
  resolveSettingsPath,
  stakeFloorPayload,
  writeStakeFloor,
} from "./moneybot-settings.js";
export type { StakeFloorState, StakeSource } from "./moneybot-settings.js";

export type MoneybotDeps = {
  liveProbe?: LiveProbe;
};

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new StakeFloorError("Body too large");
    chunks.push(buf);
  }
  if (!chunks.length) throw new StakeFloorError("JSON object required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StakeFloorError("JSON object required");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StakeFloorError("JSON object required");
  }
  return parsed as Record<string, unknown>;
}

export async function handleMoneybot(
  req: IncomingMessage,
  res: ServerResponse,
  env: Record<string, string | undefined> = process.env,
  deps: MoneybotDeps = {},
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  if (!url.pathname.startsWith("/api/moneybot")) return false;
  try {
    if (url.pathname === "/api/moneybot/floor") {
      if (req.method === "GET") {
        send(res, 200, stakeFloorPayload(readStakeFloor(env)));
        return true;
      }
      if (req.method === "POST") {
        const body = await readJsonObject(req);
        if (!isAllowedStakeFloor(body.min_stake_usd)) {
          send(res, 400, { error: "min_stake_usd must be one of 1, 5, 10, 15, 20, 25" });
          return true;
        }
        send(res, 200, stakeFloorPayload(writeStakeFloor(env, body.min_stake_usd)));
        return true;
      }
      send(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (url.pathname === "/api/moneybot/hourly") {
      if (req.method !== "GET") {
        send(res, 405, { error: "Method not allowed" });
        return true;
      }
      send(res, 200, readHourly(env));
      return true;
    }
    if (url.pathname === "/api/moneybot/suggest") {
      if (req.method !== "GET") {
        send(res, 405, { error: "Method not allowed" });
        return true;
      }
      const query = url.searchParams.get("q") || url.searchParams.get("market") || "";
      const result = suggestMarket(env, query);
      send(res, result.status, result.body);
      return true;
    }
    if (url.pathname === "/api/moneybot/activity") {
      if (req.method !== "GET") {
        send(res, 405, { error: "Method not allowed" });
        return true;
      }
      send(res, 200, { dry_runs: listDryRuns(env) });
      return true;
    }
    if (url.pathname === "/api/moneybot/dry-run-order") {
      if (req.method !== "POST") {
        send(res, 405, { error: "Method not allowed" });
        return true;
      }
      const body = await readJsonObject(req);
      const result = recordDryRun(env, body, deps.liveProbe);
      send(res, result.status, result.body);
      return true;
    }
    send(res, 404, { error: "Unknown money bot route" });
    return true;
  } catch (error) {
    const status = error instanceof StakeFloorError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Money bot request failed";
    send(res, status, { error: message });
    return true;
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ALLOWED_STAKE_FLOORS = [1, 5, 10, 15, 20, 25] as const;
export const DEFAULT_STAKE_FLOOR = 5;
export const STAKE_FLOOR_NOTE = "Strict no-bumping — picks below this floor are skipped";
export const SHARED_SETTINGS_DIR = "/home/box/shared/money-desk/config";
export const SHARED_SETTINGS_PATH = "/home/box/shared/money-desk/config/runtime_settings.json";

const FALLBACK_RELATIVE = path.join("data", "runtime_settings.json");

export class StakeFloorError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "StakeFloorError";
    this.status = status;
  }
}

export type StakeSource = "env" | "file" | "default";

export type StakeFloorState = {
  min_stake_usd: number;
  updated_at: string | null;
  source: StakeSource;
  persisted_min_stake_usd: number | null;
  path: string;
  allowed: number[];
  note: string;
};

type StoredSettings = {
  min_stake_usd: number | null;
  updated_at: string | null;
  extra: Record<string, unknown>;
};

export function isAllowedStakeFloor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && ALLOWED_STAKE_FLOORS.some((floor) => floor === value);
}

export function envStakeFloor(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return isAllowedStakeFloor(parsed) ? parsed : null;
}

function sharedConfigDirExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function resolveSettingsPath(
  env: Record<string, string | undefined>,
  sharedDirExists: (dir: string) => boolean = sharedConfigDirExists,
): string {
  const explicit = env.MONEYBOT_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  if (sharedDirExists(SHARED_SETTINGS_DIR)) return SHARED_SETTINGS_PATH;
  return path.join(process.cwd(), FALLBACK_RELATIVE);
}

function emptyStored(): StoredSettings {
  return { min_stake_usd: null, updated_at: null, extra: {} };
}

function readStored(file: string): StoredSettings {
  if (!existsSync(file)) return emptyStored();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return emptyStored();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyStored();
  const record = parsed as Record<string, unknown>;
  const { min_stake_usd, updated_at, ...extra } = record;
  return {
    min_stake_usd: isAllowedStakeFloor(min_stake_usd) ? min_stake_usd : null,
    updated_at: typeof updated_at === "string" && updated_at.trim() ? updated_at : null,
    extra,
  };
}

function viewOf(state: Omit<StakeFloorState, "allowed" | "note">): StakeFloorState {
  return {
    ...state,
    allowed: [...ALLOWED_STAKE_FLOORS],
    note: STAKE_FLOOR_NOTE,
  };
}

export function readStakeFloor(
  env: Record<string, string | undefined> = process.env,
  sharedDirExists?: (dir: string) => boolean,
): StakeFloorState {
  const file = resolveSettingsPath(env, sharedDirExists);
  const stored = readStored(file);
  const override = envStakeFloor(env.MONEYBOT_MIN_STAKE_USD);
  if (override != null) {
    return viewOf({
      min_stake_usd: override,
      updated_at: stored.updated_at,
      source: "env",
      persisted_min_stake_usd: stored.min_stake_usd,
      path: file,
    });
  }
  if (stored.min_stake_usd != null) {
    return viewOf({
      min_stake_usd: stored.min_stake_usd,
      updated_at: stored.updated_at,
      source: "file",
      persisted_min_stake_usd: stored.min_stake_usd,
      path: file,
    });
  }
  return viewOf({
    min_stake_usd: DEFAULT_STAKE_FLOOR,
    updated_at: null,
    source: "default",
    persisted_min_stake_usd: null,
    path: file,
  });
}

export function writeStakeFloor(
  env: Record<string, string | undefined>,
  value: number,
  now = new Date(),
  sharedDirExists?: (dir: string) => boolean,
): StakeFloorState {
  if (!isAllowedStakeFloor(value)) {
    throw new StakeFloorError("min_stake_usd must be one of 1, 5, 10, 15, 20, 25");
  }
  const file = resolveSettingsPath(env, sharedDirExists);
  const stored = readStored(file);
  const updated_at = now.toISOString();
  const next: Record<string, unknown> = { min_stake_usd: value, updated_at };
  for (const [key, entry] of Object.entries(stored.extra)) {
    if (key === "min_stake_usd" || key === "updated_at") continue;
    next[key] = entry;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file);
  return readStakeFloor(env, sharedDirExists);
}

export function stakeFloorPayload(state: StakeFloorState): Omit<StakeFloorState, "path"> {
  const { path: _path, ...payload } = state;
  return payload;
}

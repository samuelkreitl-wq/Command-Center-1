import type { ContractWindow } from "./types";

export const AUTO_LOCK_LEAD_MS = 30_000;
export const AUTO_LOCK_GRACE_MS = 30_000;

/** True only during the 30-second pre-open lead window or after its start. */
export function isAutoLockDue(contract: ContractWindow, now = Date.now()): boolean {
  if (!contract.openTime) return false;
  const opensAt = Date.parse(contract.openTime);
  const closesAt = Date.parse(contract.closeTime);
  return Number.isFinite(opensAt) &&
    Number.isFinite(closesAt) &&
    closesAt > now &&
    now >= opensAt - AUTO_LOCK_LEAD_MS &&
    now <= opensAt + AUTO_LOCK_GRACE_MS;
}

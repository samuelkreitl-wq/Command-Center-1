import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time check. Missing and wrong both fail. The password is never logged. */
export function approvalPasswordOk(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (!expected) return false;
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function passwordConfigured(expected: string | undefined): boolean {
  return typeof expected === "string" && expected.length > 0;
}

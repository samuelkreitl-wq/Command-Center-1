/**
 * Kalshi request signing. RSA keys use RSA-PSS SHA-256 with the digest-length salt.
 * Ed25519 keys sign the same preimage. The path excludes the query string.
 * The private key is read from the environment or a file path. It is never logged.
 */

import { constants, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function loadPrivateKeyPem(env: Record<string, string | undefined> = process.env): string | null {
  const inline = env.KALSHI_PRIVATE_KEY;
  if (inline && inline.includes("BEGIN")) return inline.replace(/\\n/g, "\n");
  const path = env.KALSHI_PRIVATE_KEY_PATH || (inline && !inline.includes("BEGIN") ? inline : "");
  if (path && existsSync(path)) return readFileSync(path, "utf8");
  return null;
}

export function signKalshiRequest(pem: string, timestamp: string, method: string, path: string): string {
  const key: KeyObject = createPrivateKey(pem);
  const message = Buffer.from(`${timestamp}${method.toUpperCase()}${path.split("?")[0]}`);
  if (key.asymmetricKeyType === "ed25519") return sign(null, message, key).toString("base64");
  return sign("sha256", message, {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

export function kalshiTradeBase(env: Record<string, string | undefined> = process.env): string {
  if (env.KALSHI_API_BASE) return env.KALSHI_API_BASE.replace(/\/$/, "");
  if ((env.KALSHI_ENV || "demo").toLowerCase() === "prod") return "https://api.elections.kalshi.com/trade-api/v2";
  return "https://demo-api.kalshi.co/trade-api/v2";
}

export function kalshiMarketBase(env: Record<string, string | undefined> = process.env): string {
  if (env.KALSHI_MARKET_BASE) return env.KALSHI_MARKET_BASE.replace(/\/$/, "");
  if (env.KALSHI_API_BASE) return env.KALSHI_API_BASE.replace(/\/$/, "");
  return "https://api.elections.kalshi.com/trade-api/v2";
}

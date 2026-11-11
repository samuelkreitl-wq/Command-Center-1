import { constants, createPrivateKey, sign, type KeyObject } from "node:crypto";

/** PEM from KALSHI_PRIVATE_KEY_PEM. Escaped newlines are restored. Never logged. */
export function loadPrivateKeyPem(env: Record<string, string | undefined>): string | null {
  const inline = env.KALSHI_PRIVATE_KEY_PEM;
  if (!inline || !inline.includes("BEGIN")) return null;
  return inline.replace(/\\n/g, "\n");
}

/**
 * Kalshi preimage is timestamp + METHOD + path, path without the query string.
 * RSA keys use RSA-PSS SHA-256 with a digest-length salt.
 */
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

export function kalshiAuthHeaders(env: Record<string, string | undefined>, method: string, path: string): Record<string, string> {
  const keyId = env.KALSHI_API_KEY_ID;
  const pem = loadPrivateKeyPem(env);
  if (!keyId || !pem) throw new Error("KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM is not set");
  const timestamp = String(Date.now());
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signKalshiRequest(pem, timestamp, method, path),
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export const KALSHI_PREFIX = "/trade-api/v2";

export function kalshiBase(env: Record<string, string | undefined>): string {
  const raw = env.KALSHI_API_BASE?.replace(/\/$/, "");
  return raw || "https://api.elections.kalshi.com/trade-api/v2";
}

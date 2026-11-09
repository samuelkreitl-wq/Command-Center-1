import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, constants } from "node:crypto";
import { signKalshiRequest } from "./kalshi-sign";

test("RSA-PSS signature verifies over timestamp + method + path", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signature = signKalshiRequest(pem, "1700000000000", "POST", "/trade-api/v2/portfolio/orders?ignored=1");
  const ok = verify("sha256", Buffer.from("1700000000000POST/trade-api/v2/portfolio/orders"), {
    key: publicKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }, Buffer.from(signature, "base64"));
  assert.equal(ok, true);
});

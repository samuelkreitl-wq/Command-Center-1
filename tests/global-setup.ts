import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { startMock } from "../server/mock-exchange";

export default async function globalSetup() {
  mkdirSync("data", { recursive: true });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync("data/playwright-kalshi.pem", privateKey.export({ type: "pkcs8", format: "pem" }));
  const mock = await startMock(5099);
  return async () => {
    await mock.close();
  };
}

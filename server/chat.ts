import { readFileSync } from "node:fs";
import path from "node:path";
import { fetchJson } from "./net.js";
import { runScan, type ScanReport } from "./scan.js";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const memory: ChatMessage[] = [];

export function resetChat(): void {
  memory.length = 0;
}

export function buildSystemPrompt(playbook: string): string {
  return [
    "You are the assistant inside Samuel's Money Desk command center.",
    "Follow the Money Desk playbook below. You propose. You never place, cancel, or resize an order.",
    "A password typed in this chat is not an approval. Tell Samuel to use the Place bet form, which checks the password on the server.",
    "Never print API keys, private keys, or the approval password. Never invent a Kalshi strike.",
    "A 15-minute window is named by its end time. Label Kraken and Coinbase as proxies, not CF Benchmarks.",
    "If a number was not in the scan context, say it was not verified.",
    "",
    playbook.slice(0, 20000),
  ].join("\n");
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(password|pwd)\s*[:=]?\s*\S+/gi, "$1 [removed]")
    .replace(/-----BEGIN[\s\S]+?-----END [^-]+-----/g, "[removed key]");
}

export async function handleChat(input: {
  message: string;
  env?: Record<string, string | undefined>;
  run?: () => Promise<ScanReport>;
}): Promise<{ reply: string; needsKey: boolean; scanned: boolean }> {
  const env = input.env ?? process.env;
  const text = redactSecrets(input.message || "").trim();
  if (!text) return { reply: "Ask about a pick, or say run scan.", needsKey: !env.XAI_API_KEY, scanned: false };
  let scanned = false;
  let scanNote = "";
  if (/\b(run|start|do)\b.{0,20}\bscan\b/i.test(text) || /\bscan now\b/i.test(text)) {
    const report = await (input.run ?? (() => runScan({ env })))();
    scanned = true;
    scanNote = summarize(report);
  }
  memory.push({ role: "user", content: scanNote ? `${text}\n\nScan context:\n${scanNote}` : text });
  if (memory.length > 20) memory.splice(0, memory.length - 20);
  if (!env.XAI_API_KEY) {
    const reply = scanned
      ? `The scan finished. The assistant model needs XAI_API_KEY before it can talk through the picks.\n\n${scanNote}`
      : "The assistant needs XAI_API_KEY. Nothing was sent to a model. Scans and the order form still work without it. Chat cannot place a bet.";
    memory.push({ role: "assistant", content: reply });
    return { reply, needsKey: true, scanned };
  }
  const playbookPath = path.join(process.cwd(), "docs", "MONEY_DESK_PLAYBOOK.md");
  let playbook = "";
  try {
    playbook = readFileSync(playbookPath, "utf8");
  } catch {
    playbook = "Playbook file was not readable. Still refuse to place orders.";
  }
  try {
    const data = (await fetchJson("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.XAI_MODEL || "grok-4",
        temperature: 0.2,
        messages: [{ role: "system", content: buildSystemPrompt(playbook) }, ...memory],
      }),
    })) as { choices?: Array<{ message?: { content?: string } }> };
    const reply = data.choices?.[0]?.message?.content?.trim() || "The model returned an empty reply.";
    memory.push({ role: "assistant", content: reply });
    return { reply: redactSecrets(reply), needsKey: false, scanned };
  } catch (error) {
    const reply = `The xAI request failed (${error instanceof Error ? error.message : "error"}). Nothing was placed.`;
    memory.push({ role: "assistant", content: reply });
    return { reply, needsKey: false, scanned };
  }
}

function summarize(report: ScanReport): string {
  const lines = [
    `Scan ${report.finishedAt}. PASS ${report.pass.length}. WATCH ${report.watch.length}. Saved ${report.saved.length}.`,
  ];
  for (const pick of report.pass.slice(0, 8)) {
    lines.push(`PASS ${pick.market.ticker} ${pick.side} @ ${pick.price} edge ${pick.edge.cents_per_contract_after_fees}c. ${pick.proxy_label || pick.fair_prob_source}`);
  }
  for (const pick of report.watch.filter((row) => row.model !== "no model").slice(0, 6)) {
    lines.push(`WATCH ${pick.market.ticker || pick.tab} ${pick.watch_trigger || ""}`);
  }
  if (report.errors.length) lines.push(`Errors: ${report.errors.slice(0, 4).join(" | ")}`);
  return lines.join("\n");
}

/**
 * Append-only JSONL ledger. Each append writes one line and fsyncs.
 * The file is never truncated and earlier lines are never rewritten.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  CallLedger,
  CALL_LEDGER_KEY,
  MemoryStore,
  type LedgerEvent,
  type LedgerSink,
} from "./call-ledger";

/** Parse a JSONL ledger. A truncated final line is ignored. A bad earlier line is an error. */
export function readJsonlEvents(text: string): LedgerEvent[] {
  if (text === "") return [];
  const complete = text.endsWith("\n");
  const lines = text.split("\n");
  if (complete) lines.pop();
  const events: LedgerEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    const last = i === lines.length - 1;
    try {
      const parsed = JSON.parse(line) as LedgerEvent;
      if (parsed == null || typeof parsed !== "object" || !("type" in parsed)) {
        throw new Error("not an event");
      }
      events.push(parsed);
    } catch (error) {
      if (last && !complete) continue;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`BTC15 call ledger line ${i + 1} is not valid JSON (${detail})`);
    }
  }
  return events;
}

export class JsonlFileSink implements LedgerSink {
  constructor(private filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  load(): LedgerEvent[] {
    if (!existsSync(this.filePath)) return [];
    return readJsonlEvents(readFileSync(this.filePath, "utf8"));
  }

  /** Open append-only. Never uses a write/truncate flag. */
  append(event: LedgerEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const fd = openSync(this.filePath, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export function openJsonlLedger(filePath: string): CallLedger {
  return new CallLedger(new MemoryStore(), CALL_LEDGER_KEY, new JsonlFileSink(filePath));
}

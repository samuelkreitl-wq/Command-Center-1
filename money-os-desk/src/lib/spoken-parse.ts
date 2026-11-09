/**
 * One parser for typed text and Web Speech transcripts.
 * A clock time is a window close, not an open. Prices use the shorthand below.
 * "what's Bitcoin in 3 days?" is a scenario question, not an order.
 */

export type HorizonId = "1d" | "3d" | "7d";

export type ParsedTime = {
  hour: number;
  minute: number;
  ampm?: "am" | "pm";
  raw: string;
};

export type ParsedUtterance = {
  price: number | null;
  time: ParsedTime | null;
  side: "yes" | "no" | null;
  count: number | null;
  errors: string[];
};

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const FILLER = new Set([
  "price", "of", "bitcoin", "btc", "at", "the", "please", "buy", "for", "window", "close",
  "closing", "dollars", "dollar", "around", "about", "a", "an", "to", "on", "me", "show",
]);

export function parseHorizonQuestion(text: string): HorizonId | null {
  const s = text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!/\b(bitcoin|btc|what)\b/.test(s)) return null;
  if (/\b(7\s*days|seven\s*days|a\s*week|one\s*week|1\s*week)\b/.test(s)) return "7d";
  if (/\b(3\s*days|three\s*days)\b/.test(s)) return "3d";
  if (/\b(1\s*day|one\s*day)\b/.test(s)) return "1d";
  return null;
}

export function parseUtterance(text: string): ParsedUtterance {
  const errors: string[] = [];
  let s = text.toLowerCase().replace(/[’']/g, "'").replace(/\$/g, "").replace(/(\d),(\d)/g, "$1$2");
  s = s.replace(/,/g, " ").replace(/\s+/g, " ").trim();

  const times = [...s.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/g)];
  let time: ParsedTime | null = null;
  if (times.length > 1) errors.push("Say one close time.");
  if (times.length >= 1) {
    const match = times[0];
    const ampmRaw = match[3]?.replace(/\./g, "");
    const ampm = ampmRaw?.startsWith("a") ? "am" : ampmRaw?.startsWith("p") ? "pm" : undefined;
    time = { hour: Number(match[1]), minute: Number(match[2]), ampm, raw: match[0].trim() };
    s = `${s.slice(0, match.index)} ${s.slice((match.index ?? 0) + match[0].length)}`.replace(/\s+/g, " ").trim();
  }

  let side: "yes" | "no" | null = null;
  const wantsUp = /\b(up|yes)\b/.test(s);
  const wantsDown = /\b(down|no)\b/.test(s);
  if (wantsUp && wantsDown) errors.push("Say up or down, not both.");
  else if (wantsUp) side = "yes";
  else if (wantsDown) side = "no";
  s = s.replace(/\b(up|down|yes|no)\b/g, " ");

  let count: number | null = null;
  const countMatch = s.match(/\b(\d+)\s*contracts?\b/);
  if (countMatch) {
    count = Number(countMatch[1]);
    s = s.replace(countMatch[0], " ");
  }

  s = s.replace(/\b([a-z0-9.]+)\b/g, (word) => (FILLER.has(word) ? " " : word)).replace(/\s+/g, " ").trim();
  s = s.replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => String(Number(n) * 1000));

  const price = parsePriceTokens(s, errors);
  return { price, time, side, count, errors };
}

function parsePriceTokens(text: string, errors: string[]): number | null {
  if (!text) return null;
  const chunks = text.split(/\s+/).filter(Boolean);
  const numbers: number[] = [];
  const wordBuf: string[] = [];
  const flushWords = () => {
    if (!wordBuf.length) return;
    const value = wordsToNumber(wordBuf);
    wordBuf.length = 0;
    if (value == null) errors.push("Could not read the spoken price.");
    else numbers.push(value);
  };
  for (const chunk of chunks) {
    if (/^\d+(?:\.\d+)?$/.test(chunk)) {
      flushWords();
      numbers.push(Number(chunk));
      continue;
    }
    const parts = chunk.split("-").filter(Boolean);
    if (parts.every((part) => isNumberWord(part))) {
      wordBuf.push(...parts);
      continue;
    }
    flushWords();
    errors.push("Price not understood.");
  }
  flushWords();
  if (!numbers.length) return null;
  if (numbers.length > 1) {
    errors.push("Say one price.");
    return null;
  }
  return applyShorthand(numbers[0], errors);
}

function isNumberWord(word: string): boolean {
  return word in ONES || word in TENS || word === "hundred" || word === "thousand" || word === "and";
}

function wordsToNumber(tokens: string[]): number | null {
  type Tok = { k: "n"; v: number } | { k: "h" } | { k: "t" };
  const toks: Tok[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (word === "and") continue;
    if (word === "hundred") {
      toks.push({ k: "h" });
      continue;
    }
    if (word === "thousand") {
      toks.push({ k: "t" });
      continue;
    }
    if (TENS[word] != null && ONES[tokens[i + 1]] != null && ONES[tokens[i + 1]] < 10) {
      toks.push({ k: "n", v: TENS[word] + ONES[tokens[i + 1]] });
      i++;
      continue;
    }
    if (TENS[word] != null) {
      toks.push({ k: "n", v: TENS[word] });
      continue;
    }
    if (ONES[word] != null) {
      toks.push({ k: "n", v: ONES[word] });
      continue;
    }
    return null;
  }
  if (toks.length >= 3 && toks[0].k === "n" && toks[0].v >= 10 && toks[0].v <= 999 &&
      toks[1].k === "n" && toks[1].v >= 1 && toks[1].v <= 9 && toks[2].k === "h" &&
      !toks.some((tok) => tok.k === "t")) {
    let value = toks[0].v * 1000 + toks[1].v * 100;
    const rest = toks.slice(3).filter((tok): tok is { k: "n"; v: number } => tok.k === "n");
    if (!rest.length) return value;
    if (rest.length === 1 && rest[0].v < 100) return value + rest[0].v;
    return null;
  }
  let total = 0;
  let current = 0;
  for (const tok of toks) {
    if (tok.k === "n") {
      if (current === 0) current = tok.v;
      else if (tok.v < 100 && current >= 100) current += tok.v;
      else return null;
    } else if (tok.k === "h") {
      current = (current || 1) * 100;
    } else if (tok.k === "t") {
      total += (current || 1) * 1000;
      current = 0;
    }
  }
  const value = total + current;
  return value > 0 ? value : null;
}

/** 743 → 74,300. 74.4k is already expanded. Full numbers (≥ 10,000) stay as written. */
export function applyShorthand(value: number, errors: string[]): number | null {
  if (!Number.isFinite(value) || value <= 0) {
    errors.push("Price not understood.");
    return null;
  }
  if (value >= 10000) return value;
  if (Number.isInteger(value) && value >= 100 && value <= 999) return value * 100;
  errors.push("Price looks incomplete. Say 743, 74.4k, or a full price like 74400.");
  return null;
}

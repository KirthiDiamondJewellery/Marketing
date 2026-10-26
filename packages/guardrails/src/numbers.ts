import { normalizeQuotes, tokenize } from "./text.ts";

/**
 * Number extraction for the claim ledger ("never invent a number"). Finds numbers written as digits
 * ("1,200", "$5k", "40%", "3.5 million") and as words ("forty", "two hundred", "twenty-five").
 */

export type FoundNumber = {
  /** The words as written, e.g. "$5k" or "twenty five". */
  raw: string;
  /** Numeric value, e.g. 5000 or 25. Percentages keep their face value (40% → 40). */
  value: number;
  index: number;
  /** True when written as words. */
  words: boolean;
};

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const SUFFIX_SCALE: Record<string, number> = {
  k: 1_000, m: 1_000_000, mm: 1_000_000, b: 1_000_000_000, bn: 1_000_000_000,
  thousand: 1_000, million: 1_000_000, billion: 1_000_000_000, hundred: 100,
};

/** Words that make a small spoken count a claim: "three times", "five percent", "two hundred". */
const CLAIM_UNITS = new Set([
  "percent", "times", "x", "dollars", "dollar", "bucks", "grand", "k", "hours", "hour", "minutes", "days", "weeks", "months",
  "years", "clients", "customers", "leads", "calls", "jobs", "deals", "sales", "followers", "views", "people", "users",
  "projects", "homes", "reviews", "stars", "points", "pounds", "euros",
]);

const DIGIT_RE = /(?<![\p{L}\p{N}.,])(\$|£|€)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k|mm|m|bn|b|thousand|million|billion|hundred)(?![\p{L}]))?(\s?%|\s?percent(?![\p{L}]))?/giu;

function parseDigits(m: RegExpMatchArray): number {
  const intPart = (m[2] ?? "0").replace(/,/g, "");
  const frac = m[3] ?? "";
  let value = Number(`${intPart}${frac}`);
  const suffix = m[4]?.toLowerCase();
  if (suffix && SUFFIX_SCALE[suffix]) value *= SUFFIX_SCALE[suffix];
  return value;
}

/**
 * Finds every number in the text.
 * - `all` (default false): when false, small number words (one to ten) only count when a unit follows
 *   ("three times", "five clients"), because "two ways to fix it" is structure, not a claim. Digits always count.
 */
export function extractNumbers(text: string, opts: { all?: boolean } = {}): FoundNumber[] {
  const src = normalizeQuotes(text);
  const out: FoundNumber[] = [];
  const covered: [number, number][] = [];

  for (const m of src.matchAll(DIGIT_RE)) {
    const index = m.index ?? 0;
    const raw = m[0].trim();
    out.push({ raw, value: parseDigits(m), index, words: false });
    covered.push([index, index + m[0].length]);
  }

  const tokens = tokenize(src);
  const isNumberWord = (w: string) => w in UNITS || w in TENS || w in SCALES;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const w = t.word.toLowerCase();
    if (!isNumberWord(w) || covered.some(([a, b]) => t.index >= a && t.index < b)) {
      i++;
      continue;
    }
    // Consume a run of number words joined by spaces or hyphens, allowing "and" between them.
    let j = i;
    let total = 0;
    let current = 0;
    let lastEnd = t.index;
    let sawScale = false;
    let count = 0;
    while (j < tokens.length) {
      const tok = tokens[j]!;
      const lw = tok.word.toLowerCase();
      if (j > i && !/^[\s-]*$/.test(src.slice(lastEnd, tok.index))) break;
      if (lw === "and" && j > i) {
        const after = tokens[j + 1];
        if (after && isNumberWord(after.word.toLowerCase()) && /^\s+$/.test(src.slice(tok.end, after.index))) {
          lastEnd = tok.end;
          j++;
          continue;
        }
        break;
      }
      if (lw in UNITS) current += UNITS[lw]!;
      else if (lw in TENS) current += TENS[lw]!;
      else if (lw in SCALES) {
        sawScale = true;
        const scale = SCALES[lw]!;
        if (scale === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * scale;
          current = 0;
        }
      } else break;
      lastEnd = tok.end;
      count++;
      j++;
    }
    const value = total + current;
    const raw = src.slice(t.index, lastEnd);
    const next = tokens[j];
    const nextWord = next ? next.word.toLowerCase() : "";
    const followedByUnit = next !== undefined && /^\s*$/.test(src.slice(lastEnd, next.index)) && CLAIM_UNITS.has(nextWord);
    const percentSign = /^\s?%/.test(src.slice(lastEnd));
    const isSmallLone = count === 1 && !sawScale && value <= 10;
    const isLoneOne = count === 1 && w === "one";
    if (opts.all ? !isLoneOne || followedByUnit || percentSign : !isSmallLone || followedByUnit || percentSign) {
      out.push({ raw, value, index: t.index, words: true });
    }
    i = Math.max(j, i + 1);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Numeric values in a text, as a set, for ledger matching. */
export function numberValues(text: string, opts: { all?: boolean } = {}): Set<number> {
  return new Set(extractNumbers(text, opts).map((n) => n.value));
}

/** Parses a single stated value such as "1,200", "$5k" or "forty" into a number, or null. */
export function parseNumber(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const found = extractNumbers(value, { all: true });
  return found.length > 0 ? found[0]!.value : null;
}

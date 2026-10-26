/** Small, dependency-free text helpers shared by the validators. All functions are pure. */

export const EM_DASH = String.fromCharCode(0x2014);
export const EN_DASH = String.fromCharCode(0x2013);
export const ELLIPSIS = String.fromCharCode(0x2026);

/** Curly apostrophes and quotes become straight ones so phrase matching is stable. */
export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Whitespace-separated tokens that contain at least one letter or digit: the spoken word count. */
export function countWords(text: string): number {
  let n = 0;
  for (const tok of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(tok)) n++;
  return n;
}

export type Token = { word: string; index: number; end: number };

/** Word tokens with positions. Apostrophes inside words are kept ("don't"). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
  for (const m of text.matchAll(re)) {
    out.push({ word: m[0], index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Splits spoken text into sentences on . ! ? (keeps the punctuation). */
export function sentences(text: string): string[] {
  return collapseSpace(text)
    .split(/(?<=[.!?])\s+(?=["'\p{Lu}\p{N}])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive regex for a phrase with word boundaries that work for any script.
 * Whitespace inside the phrase matches any run of whitespace; apostrophes match straight or curly.
 */
export function phraseRegex(phrase: string, opts: { anchored?: boolean; global?: boolean } = {}): RegExp {
  const body = escapeRegExp(normalizeQuotes(phrase.trim()))
    .replace(/\s+/g, "\\s+")
    .replace(/'/g, "['’]");
  const startsWithWordChar = /^[\p{L}\p{N}]/u.test(phrase.trim());
  const endsWithWordChar = /[\p{L}\p{N}]$/u.test(phrase.trim());
  const start = opts.anchored ? "^[\\s\"'“]*" : startsWithWordChar ? "(?<![\\p{L}\\p{N}])" : "";
  const end = endsWithWordChar ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${start}${body}${end}`, `iu${opts.global ? "g" : ""}`);
}

/** First match of any phrase in the list, or null. Longest phrases are tried first. */
export function findPhrase(text: string, phrases: readonly string[], opts: { anchored?: boolean } = {}): { phrase: string; match: string; index: number } | null {
  const sorted = [...new Set(phrases.map((p) => p.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let best: { phrase: string; match: string; index: number } | null = null;
  for (const phrase of sorted) {
    const m = phraseRegex(phrase, opts).exec(text);
    if (m && (best === null || (m.index ?? 0) < best.index)) best = { phrase, match: m[0].trim(), index: m.index ?? 0 };
  }
  return best;
}

/** Every phrase from the list that appears in the text (each reported once). */
export function findAllPhrases(text: string, phrases: readonly string[]): { phrase: string; match: string; index: number }[] {
  const out: { phrase: string; match: string; index: number }[] = [];
  const seen = new Set<string>();
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (!phrase || seen.has(phrase.toLowerCase())) continue;
    seen.add(phrase.toLowerCase());
    const m = phraseRegex(phrase).exec(text);
    if (m) out.push({ phrase, match: m[0], index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** A short quote of the text around an index, for error messages. */
export function quoteAround(text: string, index: number, length = 40): string {
  const start = Math.max(0, index - 10);
  const slice = collapseSpace(text.slice(start, start + length));
  return `${start > 0 ? "..." : ""}${slice}${start + length < text.length ? "..." : ""}`;
}

export function truncate(text: string, max = 60): string {
  const t = collapseSpace(text);
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

/** Very common words that carry no topic. Used for callback detection and keyword suggestions. */
export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each even every few for from further get gets got had has have having he her here " +
    "hers him his how i if in into is it its itself just let like me more most my no nor not now of off on once only or other " +
    "our ours out over own really right same she should so some still such than that the their them then there these they this " +
    "those through to too under until up very was way we well were what when where which while who whom why will with would " +
    "you your yours yourself thing things gonna wanna dont don't it's that's you're i'm i've we're they're here's there's what's " +
    "one ones make makes made going know see look said say says want need take every much many back first last next time"
  ).split(/\s+/),
);

/** Crude stem so "booking", "booked" and "books" match "book" in callback checks. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, "");
  for (const suffix of ["ingly", "edly", "ing", "ers", "ies", "ed", "er", "es", "ly", "s"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      if (suffix === "ies") w += "y";
      break;
    }
  }
  return w;
}

/** Content words (no stopwords, 3+ letters), stemmed. */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(normalizeQuotes(text))) {
    const w = t.word.toLowerCase();
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}

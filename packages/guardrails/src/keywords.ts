import { IssueCollector, type ValidationResult } from "./issues.ts";
import { normalizeQuotes, STOPWORDS, tokenize } from "./text.ts";

/**
 * Keyword ledger rules. A comment keyword triggers a DM automation, so it must be:
 * - one word, 4 to 9 letters A to Z;
 * - never used before;
 * - free of substring collisions either way with every ledger word ("guide" vs "guides");
 * - not said or written anywhere in the script except the CTA itself, and never inside another word,
 *   so ordinary comments about the video don't trigger the automation.
 */

export const KEYWORD_RE = /^[A-Za-z]{4,9}$/;

/** Words so common in comments that an automation on them would fire constantly. */
export const COMMON_COMMENT_WORDS = new Set(
  (
    "this that what with have from they will your about would there their when were been more like just love great " +
    "thanks thank nice good cool wow amazing awesome please help need want info more yes yeah okay sure here know " +
    "really very much need does done make made same also some them then than into only over time people thing things " +
    "work works post video reel link send interested price cost free"
  ).split(/\s+/),
);

export function normalizeKeyword(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * Checks one keyword against the ledger and the script.
 * `ledgerWords` must not include a reservation for this same piece of content (callers filter it out).
 * In `scriptText`, the keyword written in capitals as a standalone word is treated as the CTA ("Comment GUIDE")
 * and allowed; any other appearance is an error.
 */
export function checkKeyword(word: string, ledgerWords: readonly string[], scriptText = ""): ValidationResult {
  const c = new IssueCollector();
  const raw = word.trim();
  const k = normalizeKeyword(word);

  if (!raw) {
    c.error("keyword.missing", "No keyword was given.", { fix: "Pick one word of 4 to 9 letters tied to the topic, and reserve it in the keyword ledger." });
    return c.result();
  }
  if (!KEYWORD_RE.test(raw)) {
    const why = /\s/.test(raw)
      ? "it has a space"
      : /[^A-Za-z]/.test(raw)
        ? "it has characters other than the letters A to Z"
        : `it has ${raw.length} letters`;
    c.error("keyword.format", `Keyword "${raw}" can't be used: ${why}. Keywords are one word of 4 to 9 letters A to Z.`, {
      fix: "Choose a single plain word, 4 to 9 letters, no digits, accents, spaces or symbols.",
    });
    return c.result();
  }
  if (COMMON_COMMENT_WORDS.has(k) || STOPWORDS.has(k)) {
    c.error("keyword.too_common", `Keyword "${k}" is a word people type in ordinary comments, so the DM automation would fire on comments that aren't asking for anything.`, {
      fix: "Pick a distinctive word tied to the topic or the lead magnet.",
    });
  }

  const ledger = [...new Set(ledgerWords.map(normalizeKeyword).filter(Boolean))];
  if (ledger.includes(k)) {
    c.error("keyword.reused", `Keyword "${k}" is already in the keyword ledger. Keywords are never reused, because old posts still trigger their automations.`, {
      fix: "Pick a new word that has never been used.",
    });
  } else {
    for (const used of ledger) {
      if (used.includes(k) || k.includes(used)) {
        c.error("keyword.collision", `Keyword "${k}" overlaps the used keyword "${used}". A comment with one would also trigger the other's automation.`, {
          fix: `Pick a word that neither contains "${used}" nor is contained in it.`,
        });
      }
    }
  }

  if (scriptText) {
    const text = normalizeQuotes(scriptText);
    const upper = k.toUpperCase();
    const reported = new Set<string>();
    for (const t of tokenize(text)) {
      const lw = t.word.toLowerCase();
      if (lw === k) {
        if (t.word === upper) continue; // the CTA mention, said in capitals
        if (!reported.has("as-word")) {
          reported.add("as-word");
          c.error("keyword.in_script", `Keyword "${k}" is used as an ordinary word in the script ("${t.word}"). Viewers repeating that line in comments would trigger the automation.`, {
            fix: `Reword that line, or pick a different keyword. The only place the keyword belongs is the CTA, written in capitals ("${upper}").`,
          });
        }
      } else if (lw.includes(k) && !reported.has(lw)) {
        reported.add(lw);
        c.error("keyword.inside_word", `Keyword "${k}" appears inside the script word "${t.word}". Comments quoting the script would trigger the automation.`, {
          fix: `Pick a keyword that isn't part of "${t.word}", or reword that line.`,
        });
      }
    }
  }
  return c.result();
}

/**
 * Suggests valid keywords. Candidates you pass come first, then content words from the topic text.
 * Every suggestion passes `checkKeyword` and suggestions never collide with each other.
 */
export function suggestKeywords(opts: {
  topicText: string;
  ledgerWords: readonly string[];
  scriptText?: string;
  candidates?: readonly string[];
  count?: number;
}): string[] {
  const count = opts.count ?? 5;
  const pool: string[] = [];
  for (const c of opts.candidates ?? []) pool.push(normalizeKeyword(c));
  const topicWords = tokenize(normalizeQuotes(opts.topicText))
    .map((t) => t.word.toLowerCase())
    .filter((w) => /^[a-z]{4,9}$/.test(w));
  // Prefer mid-length words (5-7 letters are easy to type and distinctive).
  const ranked = [...new Set(topicWords)].sort((a, b) => Math.abs(a.length - 6) - Math.abs(b.length - 6) || a.localeCompare(b));
  pool.push(...ranked);

  const out: string[] = [];
  for (const w of pool) {
    if (out.length >= count) break;
    if (out.includes(w)) continue;
    if (out.some((o) => o.includes(w) || w.includes(o))) continue;
    if (checkKeyword(w, opts.ledgerWords, opts.scriptText ?? "").ok) out.push(w);
  }
  return out;
}

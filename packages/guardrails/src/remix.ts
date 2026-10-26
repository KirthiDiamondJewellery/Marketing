import { IssueCollector, type ValidationResult } from "./issues.ts";
import { extractNumbers } from "./numbers.ts";
import { contentStems, countWords, normalizeQuotes, phraseRegex, tokenize, truncate } from "./text.ts";

/**
 * Remix checks: a script that closely adapts a proven post (a competitor's outlier or one of the owner's own
 * breakouts). Copying the source's structure, pacing and hook wording is the point, so nothing here punishes
 * closeness. What stays a hard gate is what would make the script someone else's:
 * - their handle, name, brand, product or catchphrase in the script or captions;
 * - their numbers or personal claims said as if they were the owner's (numbers still need a proof-inventory PASS);
 * - whole passages read off their transcript (outside the hook, which may stay near word for word).
 * Everything else is a warning that nudges the draft back toward the source when it drifts.
 */

export type RemixRules = {
  /** The source post's spoken words. Untrusted text: compared in code only, never shown to a model with tools. */
  sourceText?: string | null;
  /** The source's opening line. The hook may follow it closely. */
  hookLine?: string | null;
  /** Words that belong to the source creator: handles, names, brands, products, catchphrases, places. */
  theirTerms?: readonly string[];
  /** Beats and words in the source, for the "stay close to what worked" warnings. */
  sourceBeats?: number | null;
  sourceWords?: number | null;
  /** The source has no checked blueprint: a remix can't be written yet (the script would only be guessing). */
  blueprintMissing?: boolean;
  /** Longest run of words copied from the source outside the hook: warn at this many words. Default 12. */
  copiedRunWarn?: number;
  /** ...and fail at this many. Default 25. */
  copiedRunError?: number;
};

export const DEFAULT_REMIX_RULES = { copiedRunWarn: 12, copiedRunError: 25 } as const;

type RemixPackage = {
  title: string;
  body: string;
  hookText: string;
  beats: { role: string; text: string }[];
  claimLedger: { claim: string; verdict: string; source?: string | null }[];
  captions?: unknown;
};

const words = (text: string) => tokenize(normalizeQuotes(text).toLowerCase()).map((t) => t.word);

/** Longest run of consecutive words two texts share, with the words themselves. */
export function longestSharedRun(a: string, b: string): { length: number; words: string[] } {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return { length: 0, words: [] };
  // Dynamic programming over suffix lengths, one row at a time.
  let prev = new Array<number>(wb.length + 1).fill(0);
  let best = 0;
  let endA = 0;
  for (let i = 1; i <= wa.length; i++) {
    const cur = new Array<number>(wb.length + 1).fill(0);
    for (let j = 1; j <= wb.length; j++) {
      if (wa[i - 1] === wb[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) {
          best = cur[j]!;
          endA = i;
        }
      }
    }
    prev = cur;
  }
  return { length: best, words: wa.slice(endA - best, endA) };
}

/** A creator term as it may be written: "@handle", "handle", "Brand Name". Terms under 3 letters are ignored. */
function termVariants(term: string): string[] {
  const t = normalizeQuotes(term).replace(/\s+/g, " ").trim();
  if (!t) return [];
  const bare = t.replace(/^@+/, "");
  const out = new Set<string>();
  if (bare.replace(/[^\p{L}\p{N}]/gu, "").length >= 3) out.add(bare);
  // Handles are often joined words: "marketing_daily" is also said "marketing daily".
  if (/[._]/.test(bare)) {
    const spaced = bare.replace(/[._]+/g, " ").trim();
    if (spaced.replace(/\s/g, "").length >= 3) out.add(spaced);
  }
  return [...out];
}

function captionStrings(captions: unknown): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") out.push({ path, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(captions, "captions");
  return out;
}

/** True when a number looks like a claim rather than structure ("3 things"): above ten, money, or a percentage. */
function claimLike(n: { raw: string; value: number }): boolean {
  return n.value > 10 || /[$£€%]|percent|k\b|thousand|million|billion/i.test(n.raw);
}

/**
 * The remix checks for one script package. `validateScript` calls this when `rules.remix` is set; it can also be
 * used on its own (e.g. a dry run in tests).
 */
export function checkRemix(pkg: RemixPackage, remix: RemixRules): ValidationResult {
  const c = new IssueCollector();

  // 0. A remix follows its source's checked blueprint; without one there is nothing to follow.
  if (remix.blueprintMissing) {
    c.error("remix.no_blueprint", "The source post has no checked blueprint yet, so this remix would be guessing at what made it work.", {
      path: "beats",
      fix: "Wait for the source's teardown (it is queued), then write the remix from its blueprint. Don't save a remix without one.",
    });
  }

  // 1. Nothing of theirs: handles, names, brands, products, catchphrases.
  // An all-caps term is their keyword ("QUOTE"): it only matches in capitals, so the plain word stays usable.
  const terms = [...new Set((remix.theirTerms ?? []).flatMap(termVariants).map((t) => (/^[A-Z0-9]{3,}$/.test(t) ? t : t.toLowerCase())))];
  if (terms.length) {
    const places: { path: string; text: string }[] = [
      { path: "title", text: pkg.title },
      { path: "hookText", text: pkg.hookText },
      { path: "body", text: pkg.body },
      ...captionStrings(pkg.captions),
    ];
    const reported = new Set<string>();
    for (const term of terms) {
      for (const p of places) {
        const re = /^[A-Z0-9]{3,}$/.test(term) ? new RegExp(phraseRegex(term).source, "u") : phraseRegex(term);
        const m = re.exec(normalizeQuotes(p.text).replace(/[@#]/g, " "));
        if (!m || reported.has(term)) continue;
        reported.add(term);
        c.error("remix.their_term", `The ${p.path === "body" ? "script" : p.path.startsWith("captions") ? "captions" : p.path} says "${m[0].trim()}", which belongs to the creator of the source post.`, {
          path: p.path,
          fix: "Keep their structure, not their identity: no handles, names, brands, products or catchphrases of theirs. Use the owner's own words and examples.",
        });
      }
    }
  }

  const source = remix.sourceText?.trim() ?? "";
  if (source) {
    // 2. Adapted, not read off their transcript (the hook may stay close; everything after it is checked).
    const afterHook = pkg.beats.filter((b) => b.role !== "hook").map((b) => b.text).join(" ");
    const run = longestSharedRun(afterHook, source);
    const warnAt = remix.copiedRunWarn ?? DEFAULT_REMIX_RULES.copiedRunWarn;
    const errorAt = Math.max(warnAt, remix.copiedRunError ?? DEFAULT_REMIX_RULES.copiedRunError);
    const quote = `"${truncate(run.words.join(" "), 80)}"`;
    if (run.length >= errorAt) {
      c.error("remix.copied_run", `${run.length} words in a row after the hook are word for word from the source post: ${quote}.`, {
        path: "body",
        fix: "Keep the beat and what it does, but say it with the owner's own example, proof and words.",
      });
    } else if (run.length >= warnAt) {
      c.warn("remix.copied_run", `${run.length} words in a row after the hook match the source post: ${quote}.`, {
        path: "body",
        fix: "Fine for a phrase; if it carries their example or story, swap in the owner's.",
      });
    }

    // 3. Their numbers are theirs. A number the source says may only be said with a proof-inventory PASS.
    const sourceValues = new Set(extractNumbers(source).filter(claimLike).map((n) => n.value));
    const reported = new Set<number>();
    for (const n of extractNumbers(pkg.body)) {
      if (!sourceValues.has(n.value) || !claimLike(n) || reported.has(n.value)) continue;
      const backing = pkg.claimLedger.filter((e) => e.verdict === "PASS" && extractNumbers(e.claim, { all: true }).some((x) => x.value === n.value));
      if (backing.some((e) => (e.source ?? "").trim().startsWith("proof:"))) continue;
      reported.add(n.value);
      c.error("remix.source_number", `The script says "${n.raw}", which is the source creator's number, not the owner's.`, {
        path: "body",
        fix: "Swap in a number from the owner's proof inventory (cite it as proof:<id>), or say it without a number.",
      });
    }
  }

  // 4. Stay close to what worked (warnings only).
  const hookLine = remix.hookLine?.trim();
  const hookBeat = pkg.beats.find((b) => b.role === "hook");
  if (hookLine && hookBeat) {
    const src = words(hookLine);
    const mine = new Set(words(hookBeat.text));
    const kept = src.filter((w) => mine.has(w)).length;
    const srcStems = contentStems(hookLine);
    const keptStems = [...contentStems(hookBeat.text)].filter((s) => srcStems.has(s)).length;
    if (src.length >= 4 && kept / src.length < 0.3 && keptStems === 0) {
      c.warn("remix.hook_drifted", "The hook no longer sounds like the source's hook, which is the part that earned the views.", {
        path: "beats[0]",
        fix: `Keep its wording and rhythm and swap only the topic words: "${truncate(hookLine, 90)}".`,
      });
    }
  }
  if (remix.sourceWords && remix.sourceWords >= 20) {
    const n = countWords(pkg.body);
    const ratio = n / remix.sourceWords;
    if (ratio < 0.6 || ratio > 1.5) {
      c.warn("remix.length_drifted", `The script is ${n} words; the source ran about ${remix.sourceWords}. Same pacing usually means about the same length.`, {
        path: "body",
        fix: ratio < 0.6 ? "Put back the beats the source had." : "Cut back to the source's beats; it worked at its length.",
      });
    }
  }
  if (remix.sourceBeats && remix.sourceBeats >= 2 && Math.abs(pkg.beats.length - remix.sourceBeats) > 1) {
    c.warn("remix.beats_drifted", `The script has ${pkg.beats.length} beats; the source had ${remix.sourceBeats}.`, {
      path: "beats",
      fix: "Follow the source's beat order one for one, changing what each beat says, not how many there are.",
    });
  }
  return c.result();
}

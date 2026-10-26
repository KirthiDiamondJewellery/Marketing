/**
 * Matches a take to its script from a transcript of the take's first minute. Deterministic, no LLM: token-set
 * similarity (how much of what was said appears in the script), word-pair overlap (word order) and a hook match
 * (the hook is said first, possibly several times: "the last full take wins").
 */

export type ScriptCandidate = { contentId: string; title: string; body: string; hook: string | null };
export type MatchResult = { contentId: string; title: string; score: number; hookScore: number; tokenScore: number; reason: string };

const STOP = new Set(
  "a an and are as at be but by for from has have i if in into is it its it's of on or so that the their there these this those to was we were what when which who will with you your our us me my they them then than just do does did not no yes can".split(
    " ",
  ),
);

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", hundred: "100",
};

/** Lower-case words without punctuation; spelled-out numbers become digits so "4" and "four" agree. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9.\s]+/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w);
}

/** Light stemming so "budgets"/"budget" and "priced"/"price" agree. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function contentTokens(text: string): string[] {
  return words(text).filter((w) => !STOP.has(w)).map(stem);
}

function bigrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

const share = (a: Set<string>, b: Set<string>) => {
  if (!a.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / a.size;
};

/**
 * Token-set similarity between what was said and the script. A take's first minute may cover only part of a
 * longer script, so the main measure is containment (said ⊂ script), balanced by a little Jaccard so a very short
 * transcript doesn't match every script that happens to share its few words.
 */
export function tokenSetScore(said: string[], script: string[]): number {
  const a = new Set(said);
  const b = new Set(script);
  if (!a.size || !b.size) return 0;
  const contained = share(a, b);
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const coverage = Math.min(1, inter / Math.min(b.size, 24));
  return 0.6 * contained + 0.15 * jaccard + 0.25 * coverage;
}

/** How much of the hook was said near the start of the take (best window over the first part of the transcript). */
export function hookScore(saidTokens: string[], hook: string | null): number {
  if (!hook) return 0;
  const h = new Set(contentTokens(hook));
  if (!h.size) return 0;
  const head = saidTokens.slice(0, Math.max(40, h.size * 4));
  const win = Math.max(h.size + 4, Math.round(h.size * 1.6));
  let best = 0;
  for (let i = 0; i < Math.max(1, head.length - win + 1); i++) {
    const seg = new Set(head.slice(i, i + win));
    best = Math.max(best, share(h, seg));
    if (best === 1) break;
  }
  return best;
}

/** Score one script against a transcript, 0 to 1. */
export function scoreScript(transcript: string, c: ScriptCandidate): MatchResult {
  const said = contentTokens(transcript);
  const scriptTokens = contentTokens(`${c.hook ?? ""} ${c.body}`);
  const tokenScore = tokenSetScore(said, scriptTokens);
  const pairScore = share(bigrams(said), bigrams(scriptTokens));
  const hs = hookScore(said, c.hook);
  const score = said.length < 4 ? 0 : Math.min(1, 0.5 * tokenScore + 0.2 * pairScore + 0.3 * hs);
  const reason =
    hs >= 0.8
      ? "The hook matches what you said first"
      : tokenScore >= 0.6
        ? "Most of what you said is in this script"
        : score > 0
          ? "Some words overlap"
          : "Too little speech to compare";
  return { contentId: c.contentId, title: c.title, score: round(score), hookScore: round(hs), tokenScore: round(tokenScore), reason };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Best first. */
export function rankScripts(transcript: string, candidates: ScriptCandidate[]): MatchResult[] {
  return candidates.map((c) => scoreScript(transcript, c)).sort((a, b) => b.score - a.score);
}

/** The match to link without asking, or null when it isn't clear enough. */
export function clearWinner(ranked: MatchResult[], opts: { above: number; margin: number }): MatchResult | null {
  const [top, second] = ranked;
  if (!top || top.score < opts.above) return null;
  if (second && top.score - second.score < opts.margin) return null;
  return top;
}

/** Plain-language confidence label for a score. */
export function confidenceLabel(score: number): "high" | "medium" | "low" {
  return score >= 0.62 ? "high" : score >= 0.4 ? "medium" : "low";
}

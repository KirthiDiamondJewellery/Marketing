/** Text normalisation used by topic grouping, cooldowns and transcript fingerprints. */

const STOPWORDS = new Set(
  ("a about above after again against all also am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each even every few for from further get gets got had has have having he her here hers " +
    "him his how i if in into is it its itself just like make makes made me more most much my no nor not now of off on once only or " +
    "other our ours out over own really same she should so some such than that the their them then there these they this those " +
    "through to too under until up us very was way we were what when where which while who whom why will with would you your yours " +
    "thing things know want need going gonna one two new people time day today year years video reel post watch here's that's it's " +
    "don't can't i'm you're they're we're")
    .split(/\s+/),
);

/** Light stemming: enough to make "hiring/hires/hired" and "tools/tool" collide, not a linguistic stemmer. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Content words of `text`: lowercased, URLs dropped, stop words removed, lightly stemmed, deduped, in order. */
export function contentWords(text: string | null | undefined, minLength = 4): string[] {
  const cleaned = (text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@]/g, " ")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of cleaned.split(/[\s-]+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < minLength || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Jaccard similarity of two word sets (0–1). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

const STAGE_DIRECTIONS = /[([][^)\]]*[)\]]|♪[^♪]*♪|♪/g;

/**
 * Normalised fingerprint for grouping near-identical videos, e.g. a main reel and its trial-reel variants
 * that share the spoken words but differ in caption. Empty transcript → "" (callers treat as "no group").
 */
export function transcriptFingerprint(transcript: string | null | undefined, chars = 220): string {
  return (transcript ?? "")
    .replace(STAGE_DIRECTIONS, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, chars);
}

/** The spoken hook: the opening sentence(s) of a transcript, capped at `maxWords`. */
export function spokenHook(transcript: string | null | undefined, maxWords = 20): string {
  const flat = (transcript ?? "").replace(STAGE_DIRECTIONS, " ").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentences = flat.split(/(?<=[.!?])\s+/);
  let hook = sentences[0] ?? "";
  // A very short first sentence ("Okay.") is not a hook; take the next one too.
  if (hook.split(" ").length < 4 && sentences[1]) hook = `${hook} ${sentences[1]}`;
  const words = hook.split(" ");
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") : hook;
}

/** Canonical form of a URL for de-duplication: no tracking params, no fragment, no trailing slash, no www. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|ref_src$|s$|si$|igsh$)/i.test(k)) u.searchParams.delete(k);
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const qs = u.searchParams.toString();
    return `${host}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

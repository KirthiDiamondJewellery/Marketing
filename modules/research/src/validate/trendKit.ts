import { z } from "zod";
import { canonicalUrl } from "@attentionos/scoring";

/**
 * The filmable kit the trend writer returns. The writer reads UNTRUSTED text and runs with no
 * tools, so its output passes two gates: this schema (shape and length) and `checkTrendKit` (deterministic
 * rules that need context: allowed sources, banned phrases, keyword rules).
 */

export const BEAT_VISUALS = ["talking_head", "source_screenshot", "source_video", "b_roll", "text_card"] as const;

export const trendKitSchema = z.object({
  /** On-screen header, a few words. */
  header: z.string().trim().min(3).max(60),
  /** The first spoken line: the whole story in one sentence. */
  hook: z.string().trim().min(5).max(160),
  beats: z.array(z.object({
    say: z.string().trim().min(1).max(260),
    visual: z.enum(BEAT_VISUALS),
    /** Which source the screenshot or clip comes from (must be one of `sources`). */
    sourceUrl: z.string().url().optional(),
    note: z.string().max(200).optional(),
  }).strict()).min(3).max(7),
  caption: z.string().trim().min(20).max(1500),
  /** Comment keyword suggestion: 4–9 letters. The keyword ledger reserves it later. */
  keyword: z.string().regex(/^[A-Za-z]{4,9}$/),
  sources: z.array(z.string().url()).min(1).max(5),
  factCheck: z.array(z.object({
    claim: z.string().max(240),
    source: z.string().url(),
    status: z.enum(["confirmed", "single_source", "unverified"]),
  }).strict()).max(10).default([]),
  /** Why this matters to the audience in brand/icp.md, one line. */
  angle: z.string().max(200).optional(),
}).strict();
export type TrendKit = z.output<typeof trendKitSchema>;

export const trendWriterOutputSchema = z.object({
  /** null when the story isn't worth filming for this audience. */
  kit: trendKitSchema.nullable(),
  skipReason: z.string().max(300).optional(),
}).strict();
export type TrendWriterOutput = z.output<typeof trendWriterOutputSchema>;

const URL_RE = /\bhttps?:\/\/[^\s)>"']+/gi;
const BARE_DOMAIN_RE = /\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|dev|app|news|info|biz|us|uk|ca|xyz)\b(?:\/\S*)?/gi;

export const SPOKEN_WORDS = { min: 30, max: 170 };

export type KitCheckContext = {
  /** URLs of the trend itself and anything it was clustered with. */
  allowedUrls: readonly string[];
  bannedPhrases: readonly string[];
};

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Deterministic checks; returns plain-language problems (empty = pass). */
export function checkTrendKit(kit: TrendKit, ctx: KitCheckContext): string[] {
  const problems: string[] = [];
  const allowed = new Set(ctx.allowedUrls.map(canonicalUrl));
  const allowedHosts = new Set(ctx.allowedUrls.map((u) => canonicalUrl(u).split("/")[0]));
  const isAllowed = (u: string) => allowed.has(canonicalUrl(u));

  for (const s of kit.sources) if (!isAllowed(s)) problems.push(`source ${s} is not one of the trend's own links`);
  for (const f of kit.factCheck) if (!isAllowed(f.source)) problems.push(`fact-check source ${f.source} is not one of the trend's own links`);
  kit.beats.forEach((b, i) => {
    if (b.sourceUrl && !kit.sources.includes(b.sourceUrl)) problems.push(`beat ${i + 1} shows a source that isn't listed in sources`);
    if ((b.visual === "source_screenshot" || b.visual === "source_video") && !b.sourceUrl) problems.push(`beat ${i + 1} needs a sourceUrl for its ${b.visual.replace("_", " ")}`);
  });

  const texts: [string, string][] = [["header", kit.header], ["hook", kit.hook], ["caption", kit.caption], ...kit.beats.map((b, i) => [`beat ${i + 1}`, b.say] as [string, string])];
  for (const [where, text] of texts) {
    for (const u of text.match(URL_RE) ?? []) if (!isAllowed(u)) problems.push(`${where} contains a link that isn't a source: ${u}`);
    for (const d of text.match(BARE_DOMAIN_RE) ?? []) {
      if (!allowedHosts.has(d.toLowerCase().replace(/^www\./, "").split("/")[0]!)) problems.push(`${where} mentions a website that isn't a source: ${d}`);
    }
    const lower = text.toLowerCase();
    for (const phrase of ctx.bannedPhrases) if (phrase.trim() && lower.includes(phrase.trim().toLowerCase())) problems.push(`${where} uses the banned phrase "${phrase}"`);
  }

  const spoken = words([kit.hook, ...kit.beats.map((b) => b.say)].join(" ")).length;
  if (spoken < SPOKEN_WORDS.min) problems.push(`the script is ${spoken} words; it needs at least ${SPOKEN_WORDS.min}`);
  if (spoken > SPOKEN_WORDS.max) problems.push(`the script is ${spoken} words; keep it under ${SPOKEN_WORDS.max} (about a minute)`);

  const kw = kit.keyword.toLowerCase();
  const scriptWords = new Set(words([kit.header, kit.hook, ...kit.beats.map((b) => b.say)].join(" ").toLowerCase().replace(/[^a-z\s]/g, " ")));
  if (scriptWords.has(kw)) problems.push(`keyword "${kit.keyword}" is a word in the script, so it would trigger on normal comments`);

  for (const f of kit.factCheck) if (f.status === "unverified") problems.push(`unverified claim must be cut or sourced: "${f.claim}"`);
  return problems;
}

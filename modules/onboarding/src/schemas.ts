import { CTA_TYPES, PLATFORMS } from "@attentionos/core";
import { z } from "zod";
import { slugify } from "./lib/brand-files.ts";
import { isHttpUrl } from "./lib/render.ts";
import {
  businessDraftSchema,
  competitorSuggestionSchema,
  sourceSuggestionSchema,
  voiceDraftSchema,
  type BusinessDraft,
  type ImportedPost,
  type VoiceDraft,
} from "./lib/state.ts";

/**
 * What each onboarding agent must answer with. These schemas are sent to the model as JSON Schema, so they stay
 * permissive about lengths (no transforms, few limits); the `sanitize*` functions then trim, dedupe and apply the
 * rules in code before anything is stored as a draft.
 */

const text = z.string();
const list = z.array(z.string());

export const siteAnalysisOutput = z.object({
  name: text.describe("The business or brand name, as the site writes it."),
  oneLiner: text.describe("One plain sentence: what they do and for whom."),
  offers: z
    .array(
      z.object({
        name: text,
        url: text.optional().describe("Full https:// link to the offer page, if there is one."),
        cta: z.enum(CTA_TYPES).describe("How people start: book_call, link_in_bio, dm_keyword, ..."),
        whoFor: text,
        whatTheyGet: text,
        price: text.describe("Only if the site states it; otherwise empty."),
        howToStart: text,
      }),
    )
    .describe("Up to 6 offers the site actually sells."),
  claimableResults: list.describe("Results the site itself claims, quoted closely. Empty if none."),
  neverPromise: list.describe("Things that would be unsafe to promise for this kind of business."),
  audience: z.object({
    who: text,
    wants: text,
    stuck: text,
    quotes: list.describe("Verbatim customer words from testimonials on the site only. Empty if none."),
    objections: list,
    notFor: text,
  }),
  summary: list.describe("Three short lines on what you understood."),
  openQuestions: list.describe("What the site didn't answer, to ask the owner later."),
});
export type SiteAnalysisOutput = z.output<typeof siteAnalysisOutput>;

export const voiceProfileOutput = z.object({
  oneLine: text,
  howWeTalk: list.describe("4 to 8 observations: rhythm, sentence length, openers, closers, humour, jargon."),
  signatureMoves: list,
  neverSay: list.describe("Tones and words that are not them."),
  bannedPhrases: list.describe("Short phrases that must never appear (cliches, hype words they never use)."),
  examples: list.describe("3 to 5 passages copied word for word from their posts."),
  summary: text,
});
export type VoiceProfileOutput = z.output<typeof voiceProfileOutput>;

export const interviewTurnOutput = z.object({
  reply: text.describe("What the owner sees next: a short reaction plus exactly one question, or the wrap-up."),
  done: z.boolean().describe("True only after the summary was approved and the files were saved."),
});
export type InterviewTurnOutput = z.output<typeof interviewTurnOutput>;

export const competitorSuggestionsOutput = z.object({
  competitors: z.array(z.object({ handle: text, platform: z.enum(PLATFORMS), tier: z.enum(["core", "adjacent", "aspirational", "remake"]), why: text })),
  sources: z.array(z.object({ kind: z.enum(["rss", "google_news", "hn", "reddit", "github"]), target: text, why: text })),
});
export type CompetitorSuggestionsOutput = z.output<typeof competitorSuggestionsOutput>;

// ───────────────────────────── Sanitizers (rules in code) ─────────────────────────────

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const clipList = (xs: string[] | undefined, n: number, each: number) => [...new Set((xs ?? []).map((x) => clip(x, each)).filter(Boolean))].slice(0, n);

export function sanitizeBusiness(out: SiteAnalysisOutput, website: string): BusinessDraft {
  const ids = new Set<string>();
  const offers = out.offers.slice(0, 6).flatMap((o) => {
    const name = clip(o.name, 120);
    if (!name) return [];
    let id = slugify(name, 40);
    for (let n = 2; ids.has(id); n++) id = `${slugify(name, 36)}-${n}`;
    ids.add(id);
    return [{ id, name, ...(isHttpUrl(o.url) ? { url: clip(o.url, 400) } : {}), cta: o.cta, whoFor: clip(o.whoFor, 600), whatTheyGet: clip(o.whatTheyGet, 1200), price: clip(o.price, 120), howToStart: clip(o.howToStart, 300) }];
  });
  return businessDraftSchema.parse({
    name: clip(out.name, 120) || "My brand",
    oneLiner: clip(out.oneLiner, 240),
    website: isHttpUrl(website) ? website : "",
    offers,
    claimableResults: clipList(out.claimableResults, 12, 300),
    neverPromise: clipList(out.neverPromise, 12, 300),
    audience: {
      who: clip(out.audience.who, 1200),
      wants: clip(out.audience.wants, 1200),
      stuck: clip(out.audience.stuck, 1200),
      quotes: clipList(out.audience.quotes, 15, 300),
      objections: clipList(out.audience.objections, 12, 400),
      notFor: clip(out.audience.notFor, 800),
    },
    summary: clipList(out.summary, 5, 300),
    openQuestions: clipList(out.openQuestions, 8, 300),
  });
}

const squash = (s: string) => s.toLowerCase().replace(/[“”"‘’'`]/g, "").replace(/\s+/g, " ").trim();

/** Keeps only examples that really appear in the owner's posts (the model may not invent "their" words). */
export function verbatimExamples(examples: string[], posts: Pick<ImportedPost, "text">[]): string[] {
  const corpus = posts.map((p) => squash(p.text)).join("\n");
  return clipList(examples, 5, 700).filter((e) => e.length >= 12 && corpus.includes(squash(e)));
}

export function sanitizeVoice(out: VoiceProfileOutput, posts: Pick<ImportedPost, "text">[]): VoiceDraft {
  const banned = clipList(out.bannedPhrases, 25, 80).filter((p) => p.length >= 2);
  return voiceDraftSchema.parse({
    oneLine: clip(out.oneLine, 300),
    howWeTalk: clipList(out.howWeTalk, 12, 400),
    signatureMoves: clipList(out.signatureMoves, 8, 300),
    neverSay: clipList(out.neverSay, 15, 300),
    bannedPhrases: banned,
    examples: verbatimExamples(out.examples, posts),
    summary: clip(out.summary, 600),
    basedOnPosts: posts.length,
  });
}

const HANDLE = /^@?[\p{L}\p{N}._-]{2,60}$/u;

export function sanitizeSuggestions(out: CompetitorSuggestionsOutput, ownHandles: string[] = []) {
  const own = new Set(ownHandles.map((h) => h.replace(/^@/, "").toLowerCase()));
  const seen = new Set<string>();
  const competitors = out.competitors
    .map((c) => ({ ...c, handle: clip(c.handle, 80).replace(/^https?:\/\/\S+?\/@?/i, "").replace(/[/?#].*$/, ""), why: clip(c.why, 300) }))
    .filter((c) => {
      const bare = c.handle.replace(/^@/, "").toLowerCase();
      const key = `${c.platform}:${bare}`;
      if (!HANDLE.test(c.handle) || own.has(bare) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => competitorSuggestionSchema.parse({ ...c, handle: c.handle.startsWith("@") ? c.handle : `@${c.handle}` }))
    .slice(0, 15);
  const seenSources = new Set<string>();
  const sources = out.sources
    .map((s) => ({ ...s, target: clip(s.target, 300).replace(/^r\//i, ""), why: clip(s.why, 300) }))
    .filter((s) => {
      if (s.target.length < 2) return false;
      if (s.kind === "rss" && !isHttpUrl(s.target)) return false;
      const key = `${s.kind}:${s.target.toLowerCase()}`;
      if (seenSources.has(key)) return false;
      seenSources.add(key);
      return true;
    })
    .map((s) => sourceSuggestionSchema.parse(s))
    .slice(0, 10);
  return { competitors, sources };
}

// ───────────────────────────── Reading the model's answer ─────────────────────────────

/**
 * The jobs validate their own answers (in `onOutput`) instead of handing the runner a JSON Schema: Claude Code's
 * `--json-schema` flag rejects the draft 2020-12 `$schema` that zod emits, so the shape travels in the prompt and the
 * answer is checked here, on either engine.
 */
export function jsonShape(schema: z.ZodType): string {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return `Reply with one JSON object only (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(json)}`;
}

/** Parses JSON from a model answer: the whole text, a fenced block, or the outermost object. */
export function parseModelJson(text: string): unknown {
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) attempts.push(fenced[1]!.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));
  for (const a of attempts) {
    try {
      return JSON.parse(a) as unknown;
    } catch {
      // next shape
    }
  }
  return undefined;
}

/** The runner hands `onOutput` either the structured answer or `{ summary: <final text> }`; returns the validated value. */
export function readModelOutput<T extends z.ZodType>(schema: T, output: unknown): z.output<T> {
  const direct = schema.safeParse(output);
  if (direct.success) return direct.data;
  const text = output && typeof output === "object" && typeof (output as { summary?: unknown }).summary === "string" ? (output as { summary: string }).summary : typeof output === "string" ? output : "";
  const candidate = parseModelJson(text);
  if (candidate === undefined) throw new Error("The answer wasn't valid JSON.");
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`The answer didn't match the expected format: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

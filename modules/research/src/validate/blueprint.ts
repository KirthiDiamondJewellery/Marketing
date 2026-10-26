import { z } from "zod";
import { CTA_TYPES } from "@attentionos/core";

/**
 * The remix blueprint: the part of a teardown the Copywriter works from when it remakes a proven post.
 *
 * It is written by the TOOL-LESS teardown run (the post's transcript and caption are untrusted) and checked here in
 * code before it is stored. Tool-using agents never see the transcript; they see this: the hook line (quoted, as
 * data), the beats with timing, the format, the CTA mechanic, why it worked, and what belongs to the creator.
 */

export const BLUEPRINT_FORMATS = ["talking_head", "green_screen", "split_screen", "voiceover_broll", "walkthrough", "skit", "demo", "text_on_screen", "other"] as const;
/** The same beat roles the Copywriter's script uses, so a source beat maps one to one onto a script beat. */
export const BLUEPRINT_BEAT_ROLES = ["hook", "turn", "proof", "rehook", "play", "close"] as const;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const blueprintBeatSchema = z.object({
  role: z.enum(BLUEPRINT_BEAT_ROLES),
  /** Rough timing, e.g. "0-3s". */
  at: text(1, 16),
  /** What the beat does for the viewer ("names the hidden cost"). */
  does: text(3, 160),
  /** What is said, in general terms, with the creator's specifics swapped for [placeholders]. */
  says: text(3, 220),
}).strict();

export const remixBlueprintSchema = z.object({
  /** What the post is about, in general terms. */
  topic: text(3, 120),
  /** The opening line exactly as spoken (or shown, for a silent hook). */
  hookLine: text(3, 220),
  /** The hook's pattern in a few words ("mistake warning", "result first"). */
  hookPattern: text(2, 60),
  /** Why the hook stops the scroll. */
  hookMechanic: text(3, 200),
  beats: z.array(blueprintBeatSchema).min(2).max(12),
  format: z.enum(BLUEPRINT_FORMATS),
  /** What is on screen: framing, b-roll, text, props. */
  visual: text(3, 220),
  /** How the ending asks for action ("comment a word to get the checklist"), or "none". */
  ctaMechanic: text(2, 200),
  ctaType: z.enum([...CTA_TYPES]).nullable().optional(),
  whyItWorked: z.array(text(3, 200)).min(1).max(4),
  /** The creator's own words to keep out, exactly as said: names, handles, business and product names, places, catchphrases, personal numbers. Not the general topic. */
  swapOut: z.array(text(2, 80)).max(12).default([]),
  /** One short note per personal story or example of theirs, to replace with the owner's own. */
  theirStories: z.array(text(3, 160)).max(6).default([]),
}).strict();
export type RemixBlueprint = z.output<typeof remixBlueprintSchema>;

/** A stored blueprint: the checked model output plus facts measured in code. */
export type StoredBlueprint = RemixBlueprint & { words: number | null; durationS: number | null; wordsPerSecond: number | null };

const URL_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ai|app)\b/i;
/** Real markup only: tags, markdown links, braces, backticks. Arrows and comparisons ("whole -> part", "<30s") are plain text. */
const MARKUP_RE = /<\/?[a-z][^<>]*>|<!--|\]\(|[{}`]/i;
const HANDLE_RE = /(^|[^\p{L}\p{N}])@[\p{L}\p{N}_.]{2,}/u;
const INSTRUCTION_RE = /\b(ignore|disregard|forget)\s+(all|any|the|your|previous|prior|above|earlier)\b|system prompt|\byou are (now )?(an?|the) (ai|assistant|model|language model)\b|\b(assistant|developer|system)\s*:|\btool[_ ]?(call|use)s?\b|mcp__|\bnew instructions?\b/i;

const wordsOf = (s: string) => s.toLowerCase().replace(/[’']/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu) ?? [];

/** True when `line` is (near enough) said in `source`: in order as a phrase, or 70% of its words in the opening. */
export function quotedFrom(line: string, source: string | null | undefined): boolean {
  if (!source) return false;
  const lw = wordsOf(line);
  const sw = wordsOf(source);
  if (lw.length === 0 || sw.length === 0) return false;
  if (` ${sw.join(" ")} `.includes(` ${lw.join(" ")} `)) return true;
  const opening = new Set(sw.slice(0, Math.max(40, lw.length * 2)));
  return lw.filter((w) => opening.has(w)).length / lw.length >= 0.7;
}

/**
 * Checks a model-written blueprint against the post it describes. Returns the blueprint with facts filled in, or
 * the problems (and no blueprint) when any field could carry something unsafe or invented.
 */
/** Cuts an over-long description at a word boundary. Never applied to the hook line, which must stay a quote. */
function clip(v: unknown, max: number): unknown {
  if (typeof v !== "string") return v;
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "");
}

/** Models run long on descriptions; trimming them loses nothing that matters, so do that before the strict check. */
function clipDescriptions(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  r.topic = clip(r.topic, 120);
  r.hookPattern = clip(r.hookPattern, 60);
  r.hookMechanic = clip(r.hookMechanic, 200);
  r.visual = clip(r.visual, 220);
  r.ctaMechanic = clip(r.ctaMechanic, 200);
  if (Array.isArray(r.whyItWorked)) r.whyItWorked = r.whyItWorked.slice(0, 4).map((w) => clip(w, 200));
  // swapOut wants bare terms; a model sometimes appends a note ("Dana, the creator's name"), so keep the term.
  if (Array.isArray(r.swapOut)) r.swapOut = r.swapOut.slice(0, 12).map((w) => clip(typeof w === "string" ? (w.split(/\s*,\s+|\s*[(:;]\s*|\s+[-–]\s+/)[0] ?? w).trim() : w, 80));
  if (Array.isArray(r.theirStories)) r.theirStories = r.theirStories.slice(0, 6).map((w) => clip(w, 160));
  if (Array.isArray(r.beats)) {
    r.beats = r.beats.slice(0, 12).map((b) => (b && typeof b === "object" ? { ...b, at: clip((b as Record<string, unknown>).at, 16), does: clip((b as Record<string, unknown>).does, 160), says: clip((b as Record<string, unknown>).says, 220) } : b));
  }
  return r;
}

export function checkBlueprint(
  raw: unknown,
  post: { authorHandle: string; transcript: string | null; spokenHook: string | null; caption: string | null; durationS: number | null },
): { blueprint: StoredBlueprint | null; problems: string[] } {
  const parsed = remixBlueprintSchema.safeParse(clipDescriptions(raw));
  if (!parsed.success) return { blueprint: null, problems: parsed.error.issues.map((i) => `blueprint.${i.path.join(".")}: ${i.message}`) };
  const bp = parsed.data;
  const problems: string[] = [];
  const fields: [string, string][] = [
    ["topic", bp.topic], ["hookLine", bp.hookLine], ["hookPattern", bp.hookPattern], ["hookMechanic", bp.hookMechanic],
    ["visual", bp.visual], ["ctaMechanic", bp.ctaMechanic],
    ...bp.beats.flatMap((b, i): [string, string][] => [[`beats[${i}].does`, b.does], [`beats[${i}].says`, b.says], [`beats[${i}].at`, b.at]]),
    ...bp.whyItWorked.map((w, i): [string, string] => [`whyItWorked[${i}]`, w]),
  ];
  for (const [path, value] of fields) {
    if (URL_RE.test(value)) problems.push(`blueprint.${path} contains a link`);
    if (MARKUP_RE.test(value)) problems.push(`blueprint.${path} contains markup`);
    if (HANDLE_RE.test(value)) problems.push(`blueprint.${path} names an @handle`);
    if (INSTRUCTION_RE.test(value)) problems.push(`blueprint.${path} reads like an instruction, not a description`);
  }
  for (const [i, s] of bp.theirStories.entries()) {
    if (URL_RE.test(s) || MARKUP_RE.test(s) || HANDLE_RE.test(s) || INSTRUCTION_RE.test(s)) problems.push(`blueprint.theirStories[${i}] isn't a plain note`);
  }
  for (const [i, s] of bp.swapOut.entries()) {
    if (URL_RE.test(s) || MARKUP_RE.test(s) || INSTRUCTION_RE.test(s)) problems.push(`blueprint.swapOut[${i}] isn't a plain name or phrase`);
  }
  if (bp.beats[0]?.role !== "hook") problems.push("blueprint.beats must start with the hook");
  const said = [post.transcript, post.spokenHook, post.caption].some((s) => quotedFrom(bp.hookLine, s));
  if (!said) problems.push("blueprint.hookLine isn't in the post's transcript or caption (it must be quoted, not written)");
  if (problems.length) return { blueprint: null, problems };

  // Code holds the facts: the creator's handle is always theirs, and length and pace come from the transcript.
  const handle = post.authorHandle.replace(/^@+/, "").trim();
  const swapOut = [...new Set([...(handle && handle !== "unknown" ? [`@${handle}`] : []), ...bp.swapOut])].slice(0, 13);
  const words = post.transcript ? wordsOf(post.transcript).length : null;
  const durationS = post.durationS && post.durationS > 0 ? post.durationS : null;
  return {
    blueprint: { ...bp, swapOut, words, durationS, wordsPerSecond: words && durationS ? Math.round((words / durationS) * 100) / 100 : null },
    problems: [],
  };
}

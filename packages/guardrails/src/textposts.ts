import { z } from "zod";
import { validateHashtags, xLength } from "./captions.ts";
import { IssueCollector, zodIssuesToIssues, type ValidationResult } from "./issues.ts";
import { checkPunctuation } from "./script.ts";
import { findAllPhrases } from "./text.ts";

/**
 * Text posts: the weekly X / Threads / LinkedIn batch. LinkedIn long-form passes a
 * quality rubric scored by the model and gated here in code: 8 overall, no criterion under 7.
 */

export const TEXT_POST_PLATFORMS = ["x", "threads", "linkedin"] as const;
export type TextPostPlatform = (typeof TEXT_POST_PLATFORMS)[number];

export const LINKEDIN_TEXT_CRITERIA = ["hook", "clarity", "usefulness", "accuracy", "formatting", "cta"] as const;
export const LINKEDIN_VISUAL_CRITERIA = ["concept_match", "house_style", "mobile_legibility", "technical_quality", "compliance"] as const;

export const textPostSchema = z.object({
  platform: z.enum(TEXT_POST_PLATFORMS),
  text: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  /** LinkedIn only: rubric scores 1 to 10 per criterion. */
  rubric: z.record(z.string(), z.number()).optional(),
  /** LinkedIn only: true when a visual was made (adds the visual criteria to the rubric). */
  hasVisual: z.boolean().optional(),
});
export type TextPost = z.output<typeof textPostSchema>;

export const TEXT_POST_LIMITS: Record<TextPostPlatform, number> = { x: 280, threads: 500, linkedin: 3000 };
export const LINKEDIN_FOLD = 210;

export function checkRubric(
  scores: Record<string, number> | undefined,
  opts: { criteria: readonly string[]; overall?: number; floor?: number; path?: string },
): ValidationResult {
  const c = new IssueCollector();
  const overall = opts.overall ?? 8;
  const floor = opts.floor ?? 7;
  const path = opts.path ?? "rubric";
  if (!scores) {
    c.error("rubric.missing", "The quality rubric hasn't been scored.", { path, fix: `Score every criterion from 1 to 10: ${opts.criteria.join(", ")}.` });
    return c.result();
  }
  const values: number[] = [];
  for (const k of opts.criteria) {
    const v = scores[k];
    if (v === undefined || !Number.isFinite(v)) {
      c.error("rubric.criterion_missing", `The rubric has no score for "${k}".`, { path: `${path}.${k}`, fix: "Score it from 1 to 10." });
      continue;
    }
    if (v < 1 || v > 10) {
      c.error("rubric.out_of_range", `The "${k}" score is ${v}; scores run from 1 to 10.`, { path: `${path}.${k}` });
      continue;
    }
    values.push(v);
    if (v < floor) c.error("rubric.below_floor", `"${k}" scored ${v}, under the floor of ${floor}.`, { path: `${path}.${k}`, fix: `Fix what's weak in ${k}, then score it again.` });
  }
  if (values.length > 0) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (avg < overall) c.error("rubric.below_bar", `The overall score is ${avg.toFixed(1)}; the bar is ${overall}.`, { path, fix: "Fix the lowest-scoring criteria first, then score again." });
  }
  return c.result();
}

export function validateTextPost(
  input: unknown,
  ctx: { bannedPhrases?: readonly string[]; allowDashes?: boolean; hashtagPool?: readonly string[]; rubric?: { overall?: number; floor?: number } } = {},
): ValidationResult {
  const c = new IssueCollector();
  const parsed = textPostSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of zodIssuesToIssues(parsed.error.issues, "text_post")) c.error(issue.code, `The text post has the wrong shape: ${issue.message}.`, { path: issue.path });
    return c.result();
  }
  const post = parsed.data;
  const composed = post.hashtags.length > 0 ? `${post.text.trim()}${post.platform === "linkedin" ? "\n\n" : " "}${post.hashtags.join(" ")}` : post.text.trim();
  const len = post.platform === "x" ? xLength(composed) : [...composed].length;
  const limit = TEXT_POST_LIMITS[post.platform];
  if (len > limit) c.error("text_post.too_long", `The ${post.platform} post is ${len} characters with hashtags${post.platform === "x" ? " (links count as 23)" : ""}; the limit is ${limit}.`, { path: "text", fix: `Cut ${len - limit} characters.` });
  if (/(^|\s)#[\p{L}\p{N}_]+/u.test(post.text)) c.error("text_post.inline_hashtags", "Hashtags are written inside the text.", { path: "text", fix: "Move them to the hashtags list." });
  const range = post.platform === "linkedin" ? { min: 3, max: 5 } : post.platform === "x" ? { min: 0, max: 2 } : { min: 0, max: 1 };
  c.merge(validateHashtags(post.hashtags, { ...range, pool: ctx.hashtagPool, path: "hashtags", where: post.platform }));
  for (const hit of findAllPhrases(post.text, ctx.bannedPhrases ?? [])) {
    c.error("text_post.banned_phrase", `The post says "${hit.match.trim()}", which is on the brand's banned list.`, { path: "text", fix: "Rewrite that part in plain words." });
  }
  const punct = checkPunctuation(post.text, { allowDashes: ctx.allowDashes, allowEllipsis: false, maxExclamations: 1, allowedCaps: [] }, "text");
  for (const e of punct.errors) if (e.code !== "caps.shouting") c.errors.push(e);
  for (const w of punct.warnings) c.warnings.push(w);

  if (post.platform === "linkedin") {
    const firstPara = post.text.trim().split(/\n\s*\n/)[0] ?? "";
    if (firstPara.length > LINKEDIN_FOLD) c.warn("text_post.linkedin_fold", `The opening runs ${firstPara.length} characters, past the ~${LINKEDIN_FOLD}-character "see more" fold.`, { path: "text", fix: "Land the hook in the first line or two." });
    if (/https?:\/\/\S+/i.test(post.text)) c.warn("text_post.linkedin_link", "There is a link in the body, which usually cuts reach.", { path: "text", fix: "Put the link in the first comment." });
    const criteria = post.hasVisual ? [...LINKEDIN_TEXT_CRITERIA, ...LINKEDIN_VISUAL_CRITERIA] : [...LINKEDIN_TEXT_CRITERIA];
    c.merge(checkRubric(post.rubric, { criteria, overall: ctx.rubric?.overall, floor: ctx.rubric?.floor }));
  }
  return c.result();
}

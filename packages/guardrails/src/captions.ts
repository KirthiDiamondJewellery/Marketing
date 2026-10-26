import { z } from "zod";
import type { CtaType } from "@attentionos/core";
import { IssueCollector, zodIssuesToIssues, type ValidationResult } from "./issues.ts";
import { EM_DASH, EN_DASH, escapeRegExp, findAllPhrases, truncate } from "./text.ts";

/**
 * Per-platform captions: one transcript becomes strict JSON for each platform.
 * Hashtags live in their own list per platform; `composeCaption` joins text and hashtags for publishing.
 */

export const CAPTION_PLATFORMS = ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads"] as const;
export type CaptionPlatform = (typeof CAPTION_PLATFORMS)[number];

/** Platforms a reel package must cover unless the context says otherwise. */
export const DEFAULT_CAPTION_PLATFORMS: readonly CaptionPlatform[] = ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x"];

/** Mirrors `CTA_TYPES` in @attentionos/core (kept local so this package has no runtime dependency on core). */
export const CTA_TYPE_VALUES = ["comment_keyword", "dm_keyword", "link_in_bio", "follow", "save_share", "book_call", "none"] as const satisfies readonly CtaType[];
type _CtaTypesComplete = Exclude<CtaType, (typeof CTA_TYPE_VALUES)[number]> extends never ? true : never;
const _ctaTypesComplete: _CtaTypesComplete = true;
void _ctaTypesComplete;

const hashtags = z.array(z.string()).default([]);

export const instagramCaptionSchema = z.strictObject({ caption: z.string().min(1), hashtags });
export const tiktokCaptionSchema = z.strictObject({ caption: z.string().min(1), hashtags });
export const youtubeCaptionSchema = z.strictObject({ title: z.string().min(1), description: z.string().default(""), hashtags });
export const facebookCaptionSchema = z.strictObject({ caption: z.string().min(1), hashtags });
export const linkedinCaptionSchema = z.strictObject({ text: z.string().min(1), hashtags });
export const xCaptionSchema = z.strictObject({ text: z.string().min(1), hashtags });
export const threadsCaptionSchema = z.strictObject({ text: z.string().min(1), hashtags });

export const captionsSchema = z.strictObject({
  instagram: instagramCaptionSchema.optional(),
  tiktok: tiktokCaptionSchema.optional(),
  youtube: youtubeCaptionSchema.optional(),
  facebook: facebookCaptionSchema.optional(),
  linkedin: linkedinCaptionSchema.optional(),
  x: xCaptionSchema.optional(),
  threads: threadsCaptionSchema.optional(),
});
export type Captions = z.output<typeof captionsSchema>;
export type CaptionsInput = z.input<typeof captionsSchema>;

/** Character limits per platform (composed caption: text plus hashtags). */
export const CAPTION_LIMITS: Record<CaptionPlatform, number> = {
  instagram: 2200,
  tiktok: 2200,
  youtube: 5000,
  facebook: 63206,
  linkedin: 3000,
  x: 280,
  threads: 500,
};
export const YOUTUBE_TITLE_MAX = 100; // must be strictly under
/** X counts every link as 23 characters (t.co). */
export const X_LINK_WEIGHT = 23;

export const DEFAULT_HASHTAG_RANGE: Record<CaptionPlatform, { min: number; max: number }> = {
  instagram: { min: 3, max: 5 },
  tiktok: { min: 3, max: 5 },
  youtube: { min: 3, max: 5 },
  facebook: { min: 3, max: 5 },
  linkedin: { min: 3, max: 5 },
  // 280 characters leave no room for five tags; zero to three niche tags on X.
  x: { min: 0, max: 3 },
  threads: { min: 0, max: 1 },
};

/** Broad reach-bait tags that say nothing about the niche. */
export const GENERIC_HASHTAGS = new Set([
  "#fyp", "#foryou", "#foryoupage", "#fypage", "#viral", "#explore", "#explorepage", "#reels", "#reel", "#reelsinstagram",
  "#instagood", "#trending", "#tiktok", "#shorts", "#youtubeshorts", "#follow", "#like", "#likeforlike", "#followme", "#instadaily",
]);

export const HASHTAG_RE = /^#[\p{L}\p{N}_]+$/u;

export type CaptionContext = {
  ctaType: CtaType;
  keyword?: string | null;
  /** Platforms that must be present. Default: DEFAULT_CAPTION_PLATFORMS. */
  platforms?: readonly CaptionPlatform[];
  bannedPhrases?: readonly string[];
  /** brand.yaml `hashtagPool`. Tags outside it warn. */
  hashtagPool?: readonly string[];
  hashtagRange?: Partial<Record<CaptionPlatform, { min: number; max: number }>>;
  allowDashes?: boolean;
  /** True when a Facebook comment-to-DM automation is set up, so "comment WORD" is allowed there too. */
  facebookCommentKeyword?: boolean;
};

const KEYWORD_CTAS: ReadonlySet<CtaType> = new Set(["comment_keyword", "dm_keyword"]);

function captionText(platform: CaptionPlatform, c: Record<string, unknown>): { field: string; text: string } {
  if (platform === "youtube") return { field: "description", text: String(c.description ?? "") };
  if (platform === "linkedin" || platform === "x" || platform === "threads") return { field: "text", text: String(c.text ?? "") };
  return { field: "caption", text: String(c.caption ?? "") };
}

/** Joins a platform caption's text and hashtags the way it will be published. */
export function composeCaption(platform: CaptionPlatform, caption: { caption?: string; text?: string; description?: string; hashtags?: string[] }): string {
  const { text } = captionText(platform, caption as Record<string, unknown>);
  const tags = (caption.hashtags ?? []).join(" ");
  if (!tags) return text.trim();
  return platform === "x" || platform === "threads" ? `${text.trim()} ${tags}` : `${text.trim()}\n\n${tags}`;
}

/** Length as X counts it: every URL weighs 23 characters. */
export function xLength(text: string): number {
  let len = 0;
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/\S+/gi)) {
    len += [...text.slice(last, m.index)].length + X_LINK_WEIGHT;
    last = (m.index ?? 0) + m[0].length;
  }
  return len + [...text.slice(last)].length;
}

export function validateHashtags(
  tags: readonly string[],
  opts: { min: number; max: number; pool?: readonly string[]; path?: string; where?: string },
): ValidationResult {
  const c = new IssueCollector();
  const where = opts.where ? ` on ${opts.where}` : "";
  if (tags.length < opts.min || tags.length > opts.max) {
    c.error("hashtags.count", `${tags.length} hashtag${tags.length === 1 ? "" : "s"}${where}; use ${opts.min === opts.max ? opts.min : `${opts.min} to ${opts.max}`}.`, {
      path: opts.path,
      fix: tags.length < opts.min ? "Add niche tags that say who the video is for and what it's about." : "Keep the most specific tags and drop the rest.",
    });
  }
  const seen = new Set<string>();
  const pool = opts.pool && opts.pool.length > 0 ? new Set(opts.pool.map((p) => (p.startsWith("#") ? p : `#${p}`).toLowerCase())) : null;
  tags.forEach((tag, i) => {
    const p = opts.path ? `${opts.path}[${i}]` : undefined;
    if (!HASHTAG_RE.test(tag)) {
      c.error("hashtags.format", `"${tag}" isn't a valid hashtag${where}: it must be # followed by letters, numbers or underscores (no spaces or dashes).`, { path: p, fix: `Write it as #${tag.replace(/[^\p{L}\p{N}_]/gu, "")}.` });
      return;
    }
    const k = tag.toLowerCase();
    if (seen.has(k)) c.error("hashtags.duplicate", `${tag} is listed twice${where}.`, { path: p, fix: "Remove the repeat." });
    seen.add(k);
    if (GENERIC_HASHTAGS.has(k)) {
      c.error("hashtags.generic", `${tag} is a broad reach tag${where}; it tells the platform nothing about who the video is for.`, { path: p, fix: "Swap it for a niche tag about the topic or the audience." });
    }
    if (pool && !pool.has(k)) c.warn("hashtags.not_in_pool", `${tag}${where} isn't in the brand's hashtag pool (brand/brand.yaml hashtagPool).`, { path: p, fix: "Use a tag from the pool, or add this one to the pool if it fits the brand." });
  });
  return c.result();
}

export function validateCaptions(captions: unknown, ctx: CaptionContext): ValidationResult {
  const c = new IssueCollector();
  const parsed = captionsSchema.safeParse(captions);
  if (!parsed.success) {
    for (const issue of zodIssuesToIssues(parsed.error.issues, "captions")) {
      c.error(issue.code, `Captions JSON has the wrong shape: ${issue.message}.`, {
        path: issue.path,
        fix: "Return exactly {instagram:{caption,hashtags}, tiktok:{caption,hashtags}, youtube:{title,description,hashtags}, facebook:{caption,hashtags}, linkedin:{text,hashtags}, x:{text,hashtags}} with no extra keys.",
      });
    }
    return c.result();
  }
  const caps = parsed.data;
  const keyword = ctx.keyword?.trim() || null;
  const isKeywordCta = KEYWORD_CTAS.has(ctx.ctaType);
  if (isKeywordCta && !keyword) {
    c.error("captions.keyword_missing", `The CTA type is ${ctx.ctaType}, but no keyword was given to check the captions against.`, { fix: "Reserve a keyword for this piece first." });
  }
  const required = ctx.platforms ?? DEFAULT_CAPTION_PLATFORMS;
  for (const p of required) {
    if (!caps[p]) c.error("captions.missing_platform", `There is no ${label(p)} caption.`, { path: p, fix: `Add the ${label(p)} entry.` });
  }

  const kw = keyword ? escapeRegExp(keyword) : null;
  const commentKw = kw ? new RegExp(`\\bcomment\\b[^.\\n]{0,25}\\b${kw}\\b`, "i") : null;
  const dmMeKw = kw ? new RegExp(`\\bdm me\\b[^.\\n]{0,15}\\b${kw}\\b`, "i") : null;
  const linkInBio = /\blink in (my |the )?bio\b/i;

  for (const platform of CAPTION_PLATFORMS) {
    const cap = caps[platform] as Record<string, unknown> | undefined;
    if (!cap) continue;
    const { field, text } = captionText(platform, cap);
    const tags = (cap.hashtags as string[] | undefined) ?? [];
    const composed = composeCaption(platform, cap as { hashtags?: string[] });

    // Length
    const limit = CAPTION_LIMITS[platform];
    const len = platform === "x" ? xLength(composed) : [...composed].length;
    if (len > limit) {
      c.error("captions.too_long", `The ${label(platform)} caption is ${len} characters with hashtags${platform === "x" ? " (links count as 23)" : ""}; the limit is ${limit}.`, {
        path: `${platform}.${field}`,
        fix: `Cut ${len - limit} characters.`,
      });
    }
    if (platform === "youtube") {
      const title = String(cap.title ?? "");
      if (title.length >= YOUTUBE_TITLE_MAX) {
        c.error("captions.youtube_title_length", `The YouTube title is ${title.length} characters; it must be under ${YOUTUBE_TITLE_MAX}.`, {
          path: "youtube.title",
          fix: `Cut at least ${title.length - YOUTUBE_TITLE_MAX + 1} characters.`,
        });
      }
    }

    // Hashtags: in the list, not inline.
    if (/(^|\s)#[\p{L}\p{N}_]+/u.test(text)) {
      c.error("captions.inline_hashtags", `The ${label(platform)} ${field} has hashtags written inside the text.`, {
        path: `${platform}.${field}`,
        fix: "Move them to the hashtags list; they are added at the end when the post is published.",
      });
    }
    const range = ctx.hashtagRange?.[platform] ?? DEFAULT_HASHTAG_RANGE[platform];
    c.merge(validateHashtags(tags, { ...range, pool: ctx.hashtagPool, path: `${platform}.hashtags`, where: label(platform) }));

    // CTA rules per platform
    const all = platform === "youtube" ? `${String(cap.title ?? "")}\n${text}` : text;
    if (isKeywordCta && keyword) {
      if (platform === "instagram") {
        if (!new RegExp(`\\b${kw}\\b`, "i").test(text)) {
          c.error("captions.instagram_keyword", `The Instagram caption doesn't contain the keyword "${keyword}".`, {
            path: "instagram.caption",
            fix: `End it with the CTA, e.g. "Comment ${keyword.toUpperCase()} and I'll send it to you."`,
          });
        }
      } else if (platform === "tiktok" || platform === "youtube") {
        if (!(dmMeKw?.test(all) || linkInBio.test(all))) {
          c.error("captions.offplatform_cta", `The ${label(platform)} caption needs "DM me ${keyword.toUpperCase()}" or "link in bio": comment keywords only trigger DMs on Instagram.`, {
            path: `${platform}.${field}`,
            fix: `Add "DM me ${keyword.toUpperCase()}" or "Link in bio".`,
          });
        }
      }
      const commentAllowed = platform === "instagram" || (platform === "facebook" && ctx.facebookCommentKeyword === true);
      if (!commentAllowed && commentKw?.test(all)) {
        c.error("captions.comment_keyword_off_instagram", `The ${label(platform)} caption asks people to comment "${keyword}", but no comment automation runs there, so nobody would get the DM.`, {
          path: `${platform}.${field}`,
          fix: platform === "tiktok" || platform === "youtube" ? `Use "DM me ${keyword.toUpperCase()}" or "Link in bio".` : "Use a link line instead (link in bio, or the tracked link).",
        });
      }
    } else if (ctx.ctaType === "link_in_bio" && (platform === "instagram" || platform === "tiktok") && !linkInBio.test(all)) {
      c.error("captions.link_in_bio_missing", `The CTA type is link in bio, but the ${label(platform)} caption never says "link in bio".`, {
        path: `${platform}.${field}`,
        fix: 'Add "Link in bio" to the last line.',
      });
    }

    // Links where they don't work
    if (platform === "instagram" && /https?:\/\/\S+/i.test(text)) {
      c.warn("captions.instagram_link", "The Instagram caption has a link, but links in Instagram captions aren't clickable.", { path: "instagram.caption", fix: 'Say "link in bio" instead.' });
    }
    if (platform === "linkedin" && /https?:\/\/\S+/i.test(text)) {
      c.warn("captions.linkedin_link", "The LinkedIn post has a link in the body, which usually cuts its reach.", { path: "linkedin.text", fix: "Put the link in the first comment." });
    }

    // Copy policy
    for (const hit of findAllPhrases(all, ctx.bannedPhrases ?? [])) {
      c.error("captions.banned_phrase", `The ${label(platform)} caption says "${hit.match}", which is on the brand's banned list.`, {
        path: `${platform}.${field}`,
        fix: "Rewrite that part in plain words (banned list: brand/brand.yaml bannedPhrases and brand/voice.md).",
      });
    }
    if (!ctx.allowDashes && (all.includes(EM_DASH) || all.includes(EN_DASH))) {
      c.error("captions.dash", `The ${label(platform)} caption has a long dash ("${truncate(all.slice(Math.max(0, all.search(/[\u2013\u2014]/) - 15)), 40)}").`, {
        path: `${platform}.${field}`,
        fix: "Use a period or a comma instead.",
      });
    }
  }
  return c.result();
}

function label(p: CaptionPlatform): string {
  return { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" }[p];
}
export { label as platformLabel };

import { CAPTION_LIMITS, xLength } from "@attentionos/guardrails";
import type { Platform } from "@attentionos/core";

/**
 * Cross-post and backfill: a reel already on Instagram is queued to other platforms. The comment-keyword
 * automation only runs on Instagram, so the "Comment WORD" line is swapped for a link line (or "link in bio" where
 * caption links aren't clickable). The link line goes last, before the hashtags, and always survives trimming.
 */

/** Platforms where a URL in the caption isn't clickable. */
export const NO_CLICKABLE_LINKS: ReadonlySet<Platform> = new Set(["tiktok", "instagram"]);

const HASHTAG_LINE = /^(\s*#[\p{L}\p{N}_]+\s*)+$/u;

export type SwapInput = {
  caption: string;
  keyword: string;
  platform: Platform;
  /** Tracked (or short) link; when missing, the link-in-bio line is used everywhere. */
  link?: string;
  /** Template with `{link}`. */
  linkLine: string;
  linkInBioLine: string;
};

export function isKeywordCtaLine(line: string, keyword: string): boolean {
  const kw = keyword.toLowerCase().replace(/[^a-z]/g, "");
  if (!kw) return false;
  const l = line.toLowerCase();
  return new RegExp(`\\b${kw}\\b`).test(l) && /\b(comment|type|reply|drop|dm)\b/.test(l);
}

/** Splits a caption into body lines and the trailing hashtag block. */
function splitHashtags(caption: string): { body: string[]; tags: string } {
  const lines = caption.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1]!.trim() === "" || HASHTAG_LINE.test(lines[end - 1]!))) end--;
  const tags = lines.slice(end).map((l) => l.trim()).filter(Boolean).join(" ");
  return { body: lines.slice(0, end), tags };
}

function measure(platform: Platform, text: string): number {
  return platform === "x" ? xLength(text) : [...text].length;
}

/** Cuts text to fit, at a word boundary, adding an ellipsis-free trailing period. */
function trimTo(platform: Platform, text: string, budget: number): string {
  if (measure(platform, text) <= budget) return text;
  const words = text.split(/\s+/);
  while (words.length > 1 && measure(platform, words.join(" ")) > budget) words.pop();
  const out = words.join(" ").replace(/[,;:]+$/, "");
  return measure(platform, out) <= budget ? out : [...out].slice(0, Math.max(0, budget)).join("");
}

export function swapKeywordCta(input: SwapInput): { caption: string; swapped: boolean } {
  const { body, tags } = splitHashtags(input.caption);
  const kept = body.filter((l) => !isKeywordCtaLine(l, input.keyword));
  const swapped = kept.length !== body.length;
  if (!swapped) return { caption: input.caption, swapped: false };

  const line = input.link && !NO_CLICKABLE_LINKS.has(input.platform)
    ? input.linkLine.replace(/\{link\}/g, input.link).replace(/\s+/g, " ").trim()
    : input.linkInBioLine.trim();
  const limit = CAPTION_LIMITS[input.platform];
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  let hashtags = tags;
  // X and Threads are tight: drop hashtags first (Threads), then trim the body so the link line stays whole.
  const compose = (t: string, h: string) => [t, line, ...(h ? [h] : [])].filter(Boolean).join(input.platform === "x" || input.platform === "threads" ? "\n" : "\n\n");
  if (measure(input.platform, compose(text, hashtags)) > limit && hashtags) hashtags = input.platform === "x" || input.platform === "threads" ? "" : hashtags;
  const over = measure(input.platform, compose(text, hashtags)) - limit;
  if (over > 0) text = trimTo(input.platform, text, measure(input.platform, text) - over);
  return { caption: compose(text, hashtags), swapped: true };
}

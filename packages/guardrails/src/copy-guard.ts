import { validateCaptions, type CaptionContext } from "./captions.ts";
import { IssueCollector, type ValidationResult } from "./issues.ts";
import { checkBanned, checkPunctuation, checkSpokenOnly } from "./script.ts";
import { validateTextPost } from "./textposts.ts";

/**
 * Copy guard for files written by an agent (wired to a Claude Code PostToolUse hook through the
 * `attentionos-guard` CLI). It runs the parts of the gates that need no database: spoken-words-only,
 * punctuation and caps, banned openers and phrases, and the caption JSON rules.
 */

export type CopyKind = "script" | "captions" | "text_post";

export type CopyGuardRules = {
  kind: CopyKind;
  bannedOpeners?: readonly string[];
  bannedPhrases?: readonly string[];
  allowDashes?: boolean;
  allowedCaps?: readonly string[];
  hashtagPool?: readonly string[];
  /** Keyword the script or captions use, when known (from frontmatter or the captions file). */
  keyword?: string | null;
  ctaType?: CaptionContext["ctaType"];
};

/** Splits optional YAML-ish frontmatter (`key: value` lines) and a leading `# Title` from a script file. */
export function parseScriptFile(text: string): { meta: Record<string, string>; title: string | null; body: string } {
  let rest = text.replace(/^﻿/, "");
  const meta: Record<string, string> = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(rest);
  if (fm) {
    for (const line of fm[1]!.split(/\r?\n/)) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
    }
    rest = rest.slice(fm[0].length);
  }
  let title: string | null = null;
  const t = /^\s*#\s+(.+)\r?\n/.exec(rest);
  if (t) {
    title = t[1]!.trim();
    rest = rest.slice(t[0].length);
  }
  return { meta, title, body: rest.trim() };
}

export function copyGuard(text: string, rules: CopyGuardRules): ValidationResult {
  const c = new IssueCollector();
  if (rules.kind === "script") {
    const { meta, body } = parseScriptFile(text);
    if (!body) {
      c.error("copy.empty", "The script file has no spoken words.", { fix: "Write the words said out loud under the title." });
      return c.result();
    }
    const keyword = rules.keyword ?? meta.keyword ?? null;
    c.merge(checkSpokenOnly(body));
    c.merge(checkPunctuation(body, { allowDashes: rules.allowDashes, allowedCaps: rules.allowedCaps, keyword }));
    c.merge(checkBanned(body, { openers: rules.bannedOpeners, phrases: rules.bannedPhrases }));
    return c.result();
  }
  if (rules.kind === "captions") {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      c.error("copy.invalid_json", `The captions file isn't valid JSON (${(err as Error).message}).`, { fix: "Write strict JSON: one object with a key per platform." });
      return c.result();
    }
    // A captions file may wrap the platforms with its CTA context: { ctaType, keyword, captions: {...} }.
    const obj = (json ?? {}) as Record<string, unknown>;
    const wrapped = typeof obj.captions === "object" && obj.captions !== null;
    const captions = wrapped ? obj.captions : json;
    const ctaType = (rules.ctaType ?? (wrapped ? obj.ctaType : undefined) ?? "none") as CaptionContext["ctaType"];
    const keyword = rules.keyword ?? (wrapped && typeof obj.keyword === "string" ? obj.keyword : null);
    const present = Object.keys((captions ?? {}) as object).filter((k) => ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads"].includes(k));
    c.merge(validateCaptions(captions, { ctaType, keyword, bannedPhrases: rules.bannedPhrases, allowDashes: rules.allowDashes, hashtagPool: rules.hashtagPool, platforms: present as CaptionContext["platforms"] }));
    return c.result();
  }
  // text_post: JSON {platform, text, hashtags, rubric?} or a JSON array of them.
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    c.error("copy.invalid_json", `The text post file isn't valid JSON (${(err as Error).message}).`);
    return c.result();
  }
  const posts = Array.isArray(json) ? json : [json];
  posts.forEach((p, i) => c.merge(validateTextPost(p, { bannedPhrases: rules.bannedPhrases, allowDashes: rules.allowDashes, hashtagPool: rules.hashtagPool }), posts.length > 1 ? `[${i}]` : undefined));
  return c.result();
}

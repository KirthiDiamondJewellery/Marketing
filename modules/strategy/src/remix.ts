import { contentWords } from "@attentionos/scoring";
import type { IdeaKind, Lane } from "./pillars.ts";

/**
 * Remix-first planning: most of the slate remakes posts that already proved themselves (competitor outliers and
 * the owner's own breakouts), and only what the brand's lanes require is original (the offer, fresh news).
 * Pure functions, so the ranking and the slot split are easy to test.
 */

export type RemixPoolItem = {
  id: string;
  url: string;
  /** "@handle" (competitors) or the owner's own handle. */
  creator: string;
  platform: string;
  /** Times the creator's normal: research's x score, or views over the owner's median for their own posts. */
  x: number;
  views: number | null;
  publishedAt: string | null;
  own: boolean;
  /** tracked_creators tier: core, adjacent, aspirational, remake, own. */
  tier: string | null;
  /** Checked teardown with a remix blueprint exists. */
  hasBlueprint: boolean;
  hasTranscript: boolean;
  /** From the checked blueprint: what the post is about (safe to show). */
  topic: string | null;
  hookPattern: string | null;
  format: string | null;
  /** Caption, spoken hook and blueprint text, for niche matching in code only. Never shown to a model. */
  matchText: string;
  /** Already remade into a piece that wasn't archived. */
  used: boolean;
  /** A competitor's pinned post or one past `bigViews`: proven whatever its age or their normal. */
  proven?: boolean;
  /**
   * Keys that identify the same video posted more than once (creators repost a hit): the creator with its spoken
   * hook, and the creator with its exact length. Only the best-ranked copy is kept.
   */
  sameVideo?: string[];
};

export type RankedRemix = RemixPoolItem & { score: number; relevance: number; reasons: string[] };

export type RemixRankOptions = {
  now: Date;
  /** Words of the owner's niche: lanes, pillars, offers, audience. */
  nicheWords: readonly string[];
  maxAgeDays: number;
  ownMaxAgeDays: number;
  minX: number;
  ownMinX: number;
  /** Views one of the owner's own posts needs to qualify, whatever their normal. Default 0 (no bar). */
  ownMinViews?: number;
  halfLifeDays: number;
  /** How long a proven post (pinned, or past bigViews) stays remixable. */
  provenMaxAgeDays?: number;
};

const D = 86_400_000;

/** Tiers the owner picked as closest to their niche weigh more. */
export const TIER_WEIGHT: Record<string, number> = { own: 1.1, core: 1, remake: 1.05, adjacent: 0.8, aspirational: 0.85 };

/**
 * 0 to 1, absolute views first: views on a log scale from 1K (0) to 1M (1), times-normal on a log scale up to 16x.
 * A reel that pulled 800K beats a post that did 5x a tiny normal, which is what "copy what works" means.
 */
export function provenScore(views: number | null, x: number | null): number {
  const v = views && views > 0 ? Math.min(1, Math.max(0, (Math.log10(views) - 3) / 3)) : 0;
  const t = x && x > 0 ? Math.min(1, Math.log2(1 + x) / Math.log2(17)) : 0;
  return 0.65 * v + 0.35 * t;
}

/**
 * Words every post and every Brand Kit uses (calls to action, platform words): they say nothing about the niche, so a
 * caption's "link in comments" never counts as a match.
 */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "link", "links", "comment", "comments", "follow", "follows", "bio", "post", "posts", "video", "videos", "reel", "reels", "content", "like", "likes",
  "share", "save", "dm", "click", "watch", "help", "people", "thing", "things", "make", "made", "want", "need", "know", "get", "got", "way", "time",
  "day", "today", "more", "most", "best", "new", "one", "first", "try", "free", "crazy", "world", "live", "part",
]);

/** Niche relevance in [0.6, 1.4]: how many of the owner's niche words the post uses (3 or more is a full match). */
export function nicheRelevance(text: string, niche: ReadonlySet<string>): number {
  if (niche.size === 0) return 1;
  const hits = new Set(contentWords(text).filter((w) => niche.has(w) && !GENERIC_WORDS.has(w))).size;
  return 0.6 + 0.8 * Math.min(1, hits / 3);
}

export function nicheWordsFrom(lanes: readonly Lane[], texts: readonly (string | null | undefined)[]): string[] {
  return [...new Set([...lanes.flatMap((l) => contentWords(`${l.name} ${l.description}`)), ...texts.flatMap((t) => contentWords(t ?? ""))])];
}

/**
 * Ranks proven posts to remake: absolute views first, then times-normal, fresher first (half-life), the owner's niche
 * and tiers first, posts with a ready blueprint a little ahead. Drops what was already remade, what's too old, what
 * didn't clearly beat its creator's normal, and the owner's own posts below `ownMinViews`.
 */
export function rankRemixSources(pool: readonly RemixPoolItem[], opts: RemixRankOptions): RankedRemix[] {
  const niche = new Set(opts.nicheWords);
  const now = opts.now.getTime();
  const out: RankedRemix[] = [];
  for (const p of pool) {
    if (p.used) continue;
    if (p.own && (p.views ?? 0) < (opts.ownMinViews ?? 0)) continue;
    const minX = p.own ? opts.ownMinX : opts.minX;
    const proven = !p.own && p.proven === true;
    if (!(p.x >= minX) && !proven) continue;
    const ageDays = p.publishedAt ? Math.max(0, (now - new Date(p.publishedAt).getTime()) / D) : null;
    const maxAge = p.own ? opts.ownMaxAgeDays : proven ? Math.max(opts.maxAgeDays, opts.provenMaxAgeDays ?? 365) : opts.maxAgeDays;
    if (ageDays !== null && ageDays > maxAge) continue;
    // Own breakouts are evergreen for the owner's audience; competitors' fade with the half-life, except posts proven
    // at scale (a pinned reel is the creator's showcase), which keep most of their pull.
    const recency = ageDays === null ? 0.5 : p.own ? 1 : Math.max(proven ? 0.8 : 0.25, 0.5 ** (ageDays / opts.halfLifeDays));
    const relevance = nicheRelevance(p.matchText, niche);
    const tier = TIER_WEIGHT[p.tier ?? (p.own ? "own" : "core")] ?? 1;
    // A ready blueprint saves a minute of teardown, no more: it nudges, it doesn't outrank a bigger post.
    const ready = p.hasBlueprint ? 1.1 : p.hasTranscript ? 1 : 0.85;
    const score = Math.round((0.1 + provenScore(p.views, p.x)) * recency * relevance * tier * ready * 1000) / 1000;
    const reasons = [
      ...(p.x > 0 ? [`${Math.round(p.x * 10) / 10}x ${p.own ? "your" : "their"} normal`] : []),
      ...(proven && !(p.x >= minX) ? ["proven at scale"] : []),
      ...(p.views ? [`${p.views.toLocaleString("en-US")} views`] : []),
      ...(relevance >= 1.2 ? ["in your niche"] : relevance <= 0.7 ? ["loosely related to your niche"] : []),
      ...(p.hasBlueprint ? ["blueprint ready"] : []),
    ];
    out.push({ ...p, score, relevance, reasons });
  }
  out.sort((a, b) => b.score - a.score || b.x - a.x || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return out.filter((r) => {
    const keys = r.sameVideo ?? [];
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}

/** `sameVideo` keys for a post: its creator with its spoken hook, and with its exact length. */
export function sameVideoKeys(creator: string, spokenHook: string | null | undefined, durationS: number | null | undefined): string[] {
  const who = creator.replace(/^@+/, "").toLowerCase();
  const hook = (spokenHook ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);
  return [...(hook.split(" ").length >= 4 ? [`${who}|hook|${hook}`] : []), ...(durationS && durationS > 0 ? [`${who}|len|${durationS.toFixed(2)}`] : [])];
}

/**
 * Splits the slate so about `share` of it is remixes. Offer slots never shrink (the brand's ask); talking heads give
 * way first, then news (fresh news still gets at least one slot when it had some).
 */
export function remixSlots(slots: Record<IdeaKind, number>, share: number): Record<IdeaKind, number> {
  const total = slots.news + slots.remix + slots.talking_head + slots.offer;
  if (total === 0) return { ...slots };
  const target = Math.min(total - slots.offer, Math.max(slots.remix, Math.round(total * Math.min(1, Math.max(0, share)))));
  const out = { ...slots };
  let need = target - out.remix;
  const take = (k: "talking_head" | "news", floor: number) => {
    const n = Math.max(0, Math.min(need, out[k] - floor));
    out[k] -= n;
    out.remix += n;
    need -= n;
  };
  take("talking_head", 0);
  take("news", slots.news > 0 ? 1 : 0);
  take("news", 0);
  return out;
}

import { median } from "./stats.ts";
import { HOUR_MS, DAY_MS, toDate, type DateLike } from "./time.ts";

/**
 * An account's "normal": medians over its MATURE posts. Every outlier ratio `x` is measured
 * against the author's own baseline, never against other accounts.
 */

export const METRIC_KEYS = ["views", "likes", "comments", "shares"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type PostSample = {
  publishedAt: DateLike | null | undefined;
  isPinned?: boolean | null;
  durationS?: number | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
};

export type BaselineOptions = {
  /** Posts younger than this are still climbing and are left out. Default 48. */
  matureHours: number;
  /** Posts older than this no longer describe the account's current normal. Default 120. */
  maxAgeDays: number;
  /** Below this many eligible posts the baseline is marked insufficient and no `x` is produced. Default 5. */
  minPosts: number;
  /** Leave short meme clips out of the baseline so they don't drag it around. Default true. */
  excludeMemes: boolean;
  /** Clips shorter than this many seconds are memes. Default 12. */
  memeMaxS: number;
};

export const DEFAULT_BASELINE_OPTIONS: BaselineOptions = {
  matureHours: 48,
  maxAgeDays: 120,
  minPosts: 5,
  excludeMemes: true,
  memeMaxS: 12,
};

export type Baseline = Record<MetricKey, number | null> & {
  /** Eligible posts the medians were taken over. */
  n: number;
  sufficient: boolean;
  computedAt: string;
};

/** A clip is a meme when its duration is known and shorter than `memeMaxS` (unknown duration is not a meme). */
export function isMemeClip(durationS: number | null | undefined, memeMaxS = DEFAULT_BASELINE_OPTIONS.memeMaxS): boolean {
  return typeof durationS === "number" && durationS > 0 && durationS < memeMaxS;
}

/** Whether a post may count toward a baseline at `now`. */
export function isBaselineEligible(post: PostSample, now: Date, opts: Partial<BaselineOptions> = {}): boolean {
  const o = { ...DEFAULT_BASELINE_OPTIONS, ...opts };
  if (post.isPinned) return false;
  const published = toDate(post.publishedAt);
  if (!published) return false;
  const ageMs = now.getTime() - published.getTime();
  if (ageMs < o.matureHours * HOUR_MS) return false;
  if (ageMs > o.maxAgeDays * DAY_MS) return false;
  if (o.excludeMemes && isMemeClip(post.durationS, o.memeMaxS)) return false;
  return true;
}

export function computeBaseline(posts: readonly PostSample[], now: Date, opts: Partial<BaselineOptions> = {}): Baseline {
  const o = { ...DEFAULT_BASELINE_OPTIONS, ...opts };
  const eligible = posts.filter((p) => isBaselineEligible(p, now, o));
  const pick = (k: MetricKey) => median(eligible.map((p) => (typeof p[k] === "number" && p[k]! >= 0 ? p[k] : null)));
  return {
    views: pick("views"),
    likes: pick("likes"),
    comments: pick("comments"),
    shares: pick("shares"),
    n: eligible.length,
    sufficient: eligible.length >= o.minPosts,
    computedAt: now.toISOString(),
  };
}

import type { Platform } from "@attentionos/core";
import { isMemeClip, METRIC_KEYS, type Baseline, type MetricKey, type PostSample } from "./baseline.ts";
import { round } from "./stats.ts";

/**
 * Outlier score: `x = Σ wᵢ · (metricᵢ / baselineᵢ)` with per-platform weights, a ratio
 * threshold AND absolute floors (so a tiny account can't win on ratio alone). Clips under 12 s are memes:
 * they get an `x` but never count as outliers.
 */

export type PlatformRule = {
  /** Weighted metrics. Missing metrics are dropped and the remaining weights renormalised. */
  weights: Partial<Record<MetricKey, number>>;
  /** Outlier when x >= threshold (and every floor is met). */
  threshold: number;
  /** Absolute minimums; a missing metric fails its floor. */
  floors: Partial<Record<MetricKey, number>>;
  memeMaxS: number;
};

export const DEFAULT_PLATFORM_RULES: Record<Platform, PlatformRule> = {
  // Comment-weighted: comments are the signal that a reel made people act, views alone are noisy.
  instagram: { weights: { comments: 0.7, views: 0.3 }, threshold: 2, floors: { comments: 50 }, memeMaxS: 12 },
  facebook: { weights: { comments: 0.7, views: 0.3 }, threshold: 2, floors: { comments: 30 }, memeMaxS: 12 },
  // View-weighted: TikTok distribution is view-driven and comment counts are sparse for most niches.
  tiktok: { weights: { views: 1 }, threshold: 5, floors: { views: 20_000 }, memeMaxS: 12 },
  youtube: { weights: { views: 0.8, comments: 0.2 }, threshold: 3, floors: { views: 10_000 }, memeMaxS: 12 },
  // LinkedIn rarely exposes views for other people's posts; reactions + comments carry the signal.
  linkedin: { weights: { comments: 0.6, likes: 0.4 }, threshold: 2, floors: { comments: 20 }, memeMaxS: 12 },
  x: { weights: { likes: 0.5, shares: 0.3, comments: 0.2 }, threshold: 3, floors: { likes: 500 }, memeMaxS: 12 },
  threads: { weights: { likes: 0.6, comments: 0.4 }, threshold: 2, floors: { likes: 100 }, memeMaxS: 12 },
};

export type RuleOverrides = Partial<Record<Platform, Partial<PlatformRule>>>;

export function resolveRule(platform: Platform, overrides: RuleOverrides = {}): PlatformRule {
  const base = DEFAULT_PLATFORM_RULES[platform];
  const o = overrides[platform] ?? {};
  return {
    weights: o.weights ?? base.weights,
    threshold: o.threshold ?? base.threshold,
    floors: o.floors ?? base.floors,
    memeMaxS: o.memeMaxS ?? base.memeMaxS,
  };
}

export type OutlierScore = {
  /** null when the baseline is insufficient or no weighted metric is available. */
  x: number | null;
  ratios: Partial<Record<MetricKey, number>>;
  floorsMet: boolean;
  isMeme: boolean;
  isOutlier: boolean;
  /** One plain-language line explaining the verdict. */
  reason: string;
};

export function scorePost(post: PostSample, baseline: Baseline | null, rule: PlatformRule): OutlierScore {
  const isMeme = isMemeClip(post.durationS, rule.memeMaxS);
  const floorsMet = Object.entries(rule.floors).every(([k, min]) => {
    const v = post[k as MetricKey];
    return typeof v === "number" && v >= (min ?? 0);
  });

  if (!baseline || !baseline.sufficient) {
    return { x: null, ratios: {}, floorsMet, isMeme, isOutlier: false, reason: "not enough mature posts to know this account's normal yet" };
  }

  const ratios: Partial<Record<MetricKey, number>> = {};
  let weighted = 0;
  let weightSum = 0;
  for (const k of METRIC_KEYS) {
    const w = rule.weights[k];
    const v = post[k];
    const b = baseline[k];
    if (!w || typeof v !== "number" || typeof b !== "number") continue;
    // Divide by at least 1 so accounts with a median of 0 comments don't explode the ratio.
    const ratio = v / Math.max(b, 1);
    ratios[k] = round(ratio);
    weighted += w * ratio;
    weightSum += w;
  }
  if (weightSum === 0) {
    return { x: null, ratios, floorsMet, isMeme, isOutlier: false, reason: "the metrics this platform is scored on are missing" };
  }
  const x = round(weighted / weightSum);
  const isOutlier = !isMeme && floorsMet && x >= rule.threshold;
  let reason: string;
  if (isMeme) reason = `short clip under ${rule.memeMaxS}s, treated as a meme`;
  else if (isOutlier) reason = `${x}x this account's normal`;
  else if (x >= rule.threshold) reason = `${x}x this account's normal but below the minimum engagement floor`;
  else reason = `${x}x this account's normal, under the ${rule.threshold}x bar`;
  return { x, ratios, floorsMet, isMeme, isOutlier, reason };
}

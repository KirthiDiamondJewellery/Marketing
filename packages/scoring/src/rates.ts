import { isNum, median, quantile, round } from "./stats.ts";

/**
 * Per-post rate metrics (analytics). Every rate is null when its inputs are unknown or its denominator is
 * zero: a missing number is "unknown", never zero, so a gap can't masquerade as a bad result.
 */

export type MetricCounts = {
  views?: number | null;
  reach?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  follows?: number | null;
  profileVisits?: number | null;
  clicks?: number | null;
  avgWatchS?: number | null;
  durationS?: number | null;
  /** 0–1: share of viewers who swiped away in the first seconds. */
  skipRate?: number | null;
  /** 0–1: share who watched to the end. */
  completionRate?: number | null;
};

export type PostRates = {
  /** (likes + comments + shares + saves) / views. Unknown parts are left out; null when all four are unknown. */
  engagementPerView: number | null;
  /** Same interactions / reach (accounts reached), the platform-native engagement rate. */
  engagementPerReach: number | null;
  /** (shares + saves) / views: people sending or keeping the post, the most north-star-friendly signal. */
  sendRate: number | null;
  saveRate: number | null;
  shareRate: number | null;
  commentRate: number | null;
  likeRate: number | null;
  /** New follows per 1,000 views. */
  followsPer1k: number | null;
  /** Profile visits / views. */
  profileVisitRate: number | null;
  /** Link clicks / views. */
  clickRate: number | null;
  /** Average watch time / video length (can exceed 1 when people rewatch). */
  watchPct: number | null;
  /** 1 − skip rate: share of viewers still there after the first seconds. */
  holdRate: number | null;
  completionRate: number | null;
};

export const RATE_KEYS = [
  "engagementPerView", "engagementPerReach", "sendRate", "saveRate", "shareRate", "commentRate", "likeRate",
  "followsPer1k", "profileVisitRate", "clickRate", "watchPct", "holdRate", "completionRate",
] as const satisfies readonly (keyof PostRates)[];
export type RateKey = (typeof RATE_KEYS)[number];

const pos = (v: number | null | undefined): v is number => isNum(v) && v > 0;
const nonNeg = (v: number | null | undefined): v is number => isNum(v) && v >= 0;
const ratio = (num: number | null | undefined, den: number | null | undefined, scale = 1, digits = 7): number | null =>
  nonNeg(num) && pos(den) ? round((num / den) * scale, digits) : null;

/** Sum of the parts that are known; null when none are. */
export function sumKnown(parts: readonly (number | null | undefined)[]): number | null {
  const known = parts.filter(nonNeg);
  return known.length ? known.reduce((s, v) => s + v, 0) : null;
}

export function interactions(m: MetricCounts): number | null {
  return sumKnown([m.likes, m.comments, m.shares, m.saves]);
}

export function postRates(m: MetricCounts): PostRates {
  const inter = interactions(m);
  const sends = sumKnown([m.shares, m.saves]);
  const rate01 = (v: number | null | undefined) => (isNum(v) && v >= 0 && v <= 1 ? v : null);
  const skip = rate01(m.skipRate);
  return {
    engagementPerView: ratio(inter, m.views),
    engagementPerReach: ratio(inter, m.reach),
    sendRate: ratio(sends, m.views),
    saveRate: ratio(m.saves, m.views),
    shareRate: ratio(m.shares, m.views),
    commentRate: ratio(m.comments, m.views),
    likeRate: ratio(m.likes, m.views),
    followsPer1k: ratio(m.follows, m.views, 1000, 3),
    profileVisitRate: ratio(m.profileVisits, m.views),
    clickRate: ratio(m.clicks, m.views),
    watchPct: ratio(m.avgWatchS, m.durationS, 1, 4),
    holdRate: skip === null ? null : round(1 - skip, 4),
    completionRate: rate01(m.completionRate),
  };
}

/**
 * Pooled rate over many posts: Σnumerator / Σdenominator over posts where both are known (not the mean of
 * per-post rates, so one tiny post can't swing it).
 */
export function pooledRate(rows: readonly { num: number | null | undefined; den: number | null | undefined }[], scale = 1): { value: number | null; n: number } {
  let num = 0;
  let den = 0;
  let n = 0;
  for (const r of rows) {
    if (!nonNeg(r.num) || !pos(r.den)) continue;
    num += r.num;
    den += r.den;
    n++;
  }
  return { value: den > 0 ? round((num / den) * scale, 6) : null, n };
}

/** Relative change (cur − prev) / prev. Null when prev is 0 and cur isn't (no basis), 0 when both are 0. */
export function change(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (!isNum(cur) || !isNum(prev)) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return round((cur - prev) / Math.abs(prev), 4);
}

/**
 * Velocity: a post's early views (its 24h snapshot) against the median early views of the account's earlier posts.
 * 1 = a normal start. Null without both numbers.
 */
export function velocity(earlyViews: number | null | undefined, baselineEarlyViews: number | null | undefined): number | null {
  if (!nonNeg(earlyViews) || !isNum(baselineEarlyViews) || baselineEarlyViews <= 0) return null;
  return round(earlyViews / Math.max(baselineEarlyViews, 1), 3);
}

export type BandPoint = { median: number | null; low: number | null; high: number | null; n: number };

/**
 * Rolling "normal" band: for every point, the median and the interquartile range (p25–p75) of the `window` points
 * before it (never including itself). Points with fewer than `minN` predecessors get an empty band.
 */
export function rollingBand(values: readonly (number | null | undefined)[], opts: { window?: number; minN?: number } = {}): BandPoint[] {
  const window = opts.window ?? 20;
  const minN = opts.minN ?? 5;
  const out: BandPoint[] = [];
  const seen: number[] = [];
  for (const v of values) {
    const prior = seen.slice(-window);
    out.push(
      prior.length >= minN
        ? { median: median(prior), low: quantile(prior, 0.25), high: quantile(prior, 0.75), n: prior.length }
        : { median: null, low: null, high: null, n: prior.length },
    );
    if (isNum(v)) seen.push(v);
  }
  return out;
}

/** Where a value sits against a band: above the p75, inside, or below the p25. */
export function bandPosition(value: number | null | undefined, band: BandPoint): "above" | "inside" | "below" | null {
  if (!isNum(value) || band.low === null || band.high === null) return null;
  if (value > band.high) return "above";
  if (value < band.low) return "below";
  return "inside";
}

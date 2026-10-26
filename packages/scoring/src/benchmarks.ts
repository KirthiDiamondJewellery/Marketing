import { isNum, median, round } from "./stats.ts";

/**
 * Competitor benchmarks: the account's typical post against the typical post of each tracked creator, plus how
 * often each side produces outliers. Medians throughout ("one 300x reel shouldn't crown anyone").
 */

export type BenchPost = { views?: number | null; likes?: number | null; comments?: number | null; x?: number | null };

export type PeerBenchmark = {
  key: string;
  label: string;
  n: number;
  medianViews: number | null;
  medianComments: number | null;
  /** (likes + comments) / views, median over posts. */
  medianEngagement: number | null;
  /** Share of posts at or above the outlier bar. */
  outlierShare: number | null;
  bestX: number | null;
};

export type Benchmarks = {
  own: PeerBenchmark;
  peers: PeerBenchmark[];
  /** Median of the peers' medians. */
  peerMedianViews: number | null;
  peerMedianEngagement: number | null;
  peerOutlierShare: number | null;
  /** own median views / peer median views. */
  viewsRatio: number | null;
  engagementRatio: number | null;
  /** Share of peers whose median views are below the account's (0–1). */
  viewsPercentile: number | null;
  gaps: string[];
};

const engagement = (p: BenchPost) =>
  isNum(p.views) && p.views > 0 && (isNum(p.likes) || isNum(p.comments)) ? ((p.likes ?? 0) + (p.comments ?? 0)) / p.views : null;

export function summarize(key: string, label: string, posts: readonly BenchPost[], outlierX: number): PeerBenchmark {
  const scored = posts.filter((p) => isNum(p.x));
  const r = (v: number | null, d = 3) => (v === null ? null : round(v, d));
  return {
    key,
    label,
    n: posts.length,
    medianViews: r(median(posts.map((p) => p.views)), 0),
    medianComments: r(median(posts.map((p) => p.comments)), 1),
    medianEngagement: r(median(posts.map(engagement)), 5),
    outlierShare: scored.length ? r(scored.filter((p) => p.x! >= outlierX).length / scored.length, 3) : null,
    bestX: scored.length ? r(Math.max(...scored.map((p) => p.x!)), 2) : null,
  };
}

export function benchmarks(
  own: readonly BenchPost[],
  peers: readonly { key: string; label: string; posts: readonly BenchPost[] }[],
  opts: { outlierX?: number; ownBreakoutX?: number; minPosts?: number } = {},
): Benchmarks {
  const minPosts = opts.minPosts ?? 5;
  const ownSummary = summarize("own", "You", own, opts.ownBreakoutX ?? 2);
  const peerSummaries = peers.map((p) => summarize(p.key, p.label, p.posts, opts.outlierX ?? 2)).sort((a, b) => (b.medianViews ?? -1) - (a.medianViews ?? -1));
  const usable = peerSummaries.filter((p) => p.n >= minPosts);
  const peerMedianViews = median(usable.map((p) => p.medianViews));
  const peerMedianEngagement = median(usable.map((p) => p.medianEngagement));
  const peerOutlierShare = median(usable.map((p) => p.outlierShare));
  const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? round(a / b, 3) : null);
  const withViews = usable.filter((p) => p.medianViews !== null);
  const gaps: string[] = [];
  if (own.length < minPosts) gaps.push(`GAP: ${own.length} of your posts have numbers (need ${minPosts}) to compare with tracked creators.`);
  if (usable.length === 0) gaps.push(`GAP: no tracked creator has ${minPosts} scanned posts yet. Competitor scans fill this in daily.`);
  const thin = peerSummaries.filter((p) => p.n < minPosts).map((p) => p.label);
  if (thin.length && usable.length) gaps.push(`GAP: ${thin.join(", ")} ${thin.length === 1 ? "has" : "have"} fewer than ${minPosts} scanned posts and ${thin.length === 1 ? "is" : "are"} left out of the medians.`);
  return {
    own: ownSummary,
    peers: peerSummaries,
    peerMedianViews: peerMedianViews === null ? null : round(peerMedianViews, 0),
    peerMedianEngagement: peerMedianEngagement === null ? null : round(peerMedianEngagement, 5),
    peerOutlierShare: peerOutlierShare === null ? null : round(peerOutlierShare, 3),
    viewsRatio: ratio(ownSummary.medianViews, peerMedianViews),
    engagementRatio: ratio(ownSummary.medianEngagement, peerMedianEngagement),
    viewsPercentile: ownSummary.medianViews !== null && withViews.length
      ? round(withViews.filter((p) => p.medianViews! < ownSummary.medianViews!).length / withViews.length, 3)
      : null,
    gaps,
  };
}

import type { Platform } from "@attentionos/core";
import { emptyCounts, median, postRates, velocity, type FunnelCounts, type PostRates } from "@attentionos/scoring";
import { computeOwnScores, hasNumbers, type OwnPostScore } from "../metrics.ts";
import { learnSettings } from "../settings.ts";
import { DAY_MS, retentionAt, type AnalyticsCtx } from "./ctx.ts";
import { funnelByPost } from "./funnel.ts";

/**
 * One row per own post with every number Insights and the agents use: the settled metrics, the rate family,
 * x against the account's normal, velocity, hold at 3 seconds, and the business funnel credited to it.
 */

export type PostFact = OwnPostScore & {
  rates: PostRates;
  /** 24h views against the median 24h views of the account's other posts on the platform. */
  velocity: number | null;
  /** % of viewers still watching at 3 s (retention curve), else 1 − skip rate. */
  hold3s: number | null;
  funnel: FunnelCounts;
  flag: "breakout" | "flop" | null;
  /** "full" with views plus interactions, "partial" with only some numbers, "none" before the first capture. */
  data: "full" | "partial" | "none";
};

export type PlatformNorms = {
  posts: number;
  medianViews: number | null;
  medianEarlyViews: number | null;
  medianEngagement: number | null;
  medianSendRate: number | null;
  medianFollowsPer1k: number | null;
  medianHold3s: number | null;
};

export type PostFacts = {
  posts: PostFact[];
  /** Per-platform medians of the account's settled posts, the "normal" every comparison uses. */
  norms: Partial<Record<Platform, PlatformNorms>>;
  baselines: Awaited<ReturnType<typeof computeOwnScores>>["baselines"];
};

export function hold3sOf(p: Pick<OwnPostScore, "retention" | "skipRate">): number | null {
  const fromCurve = retentionAt(p.retention ?? undefined, 3);
  if (fromCurve !== null) return Math.round(fromCurve * 10) / 1000;
  return p.skipRate !== null && p.skipRate >= 0 && p.skipRate <= 1 ? Math.round((1 - p.skipRate) * 1000) / 1000 : null;
}

/**
 * `includeScanned` adds the owner's posts read off their public account during setup (`source: "scan"`), for
 * read-only views. Writers (attribution, post-mortems) leave it off: those rows are not `posts`.
 */
export async function postFacts(ctx: AnalyticsCtx, opts: { sinceDays?: number; persist?: boolean; includeScanned?: boolean } = {}): Promise<PostFacts> {
  const settings = learnSettings(ctx).postMortem;
  const { posts, baselines } = await computeOwnScores(ctx, { persist: opts.persist ?? false, includeScanned: opts.includeScanned ?? false });
  const firstPublished = posts[0]?.publishedAt ? new Date(posts[0].publishedAt) : new Date(ctx.now().getTime() - 365 * DAY_MS);
  const funnel = await funnelByPost(ctx, firstPublished, ctx.now());

  const facts: PostFact[] = posts.map((p) => {
    const rates = postRates({
      views: p.views, reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves, follows: p.follows,
      profileVisits: p.profileVisits, clicks: p.clicks, avgWatchS: p.avgWatchS, durationS: p.durationS, skipRate: p.skipRate, completionRate: p.completionRate,
    });
    // A scan sees shares on some platforms but never saves, so its "send rate" would be half the number: leave it out.
    if (p.source === "scan") rates.sendRate = null;
    const f = funnel.byPost.get(p.postId) ?? funnel.byPost.get(p.numbersFrom) ?? emptyCounts();
    const counts = { ...f, leads: Math.max(f.leads, p.leads ?? 0) };
    const known = [p.views, p.likes, p.comments].filter((v) => v !== null).length;
    return {
      ...p,
      leads: counts.leads,
      rates,
      velocity: null,
      hold3s: hold3sOf(p),
      funnel: counts,
      flag: p.x === null || !p.settled ? null : p.x >= settings.breakoutX ? "breakout" : p.x < settings.flopX ? "flop" : null,
      data: !hasNumbers(p) ? "none" : known === 3 ? "full" : "partial",
    };
  });

  const norms: PostFacts["norms"] = {};
  const now = ctx.now().getTime();
  for (const platform of new Set(facts.map((p) => p.platform))) {
    const mine = facts.filter((p) => p.platform === platform && p.data !== "none");
    const settled = mine.filter((p) => p.settled);
    norms[platform] = {
      posts: settled.length,
      medianViews: median(settled.map((p) => p.views)),
      medianEarlyViews: median(mine.filter((p) => now - Date.parse(p.publishedAt) >= 24 * 3_600_000).map((p) => p.earlyViews)),
      medianEngagement: median(settled.map((p) => p.rates.engagementPerView)),
      medianSendRate: median(settled.map((p) => p.rates.sendRate)),
      medianFollowsPer1k: median(settled.map((p) => p.rates.followsPer1k)),
      medianHold3s: median(settled.map((p) => p.hold3s)),
    };
  }
  // Velocity against the other posts' early views (a post is never its own baseline).
  for (const p of facts) {
    if (p.earlyViews === null) continue;
    const others = facts.filter((q) => q.platform === p.platform && q.postId !== p.postId && q.earlyViews !== null);
    if (others.length >= 3) p.velocity = velocity(p.earlyViews, median(others.map((q) => q.earlyViews)));
  }

  const since = opts.sinceDays ? now - opts.sinceDays * DAY_MS : null;
  return { posts: since === null ? facts : facts.filter((p) => Date.parse(p.publishedAt) >= since), norms, baselines };
}

const FEATURE_WORDS: Record<string, string> = {
  hook_pattern: "hook pattern", lane: "lane", format: "format", angle: "angle", funnel_stage: "funnel stage", cta_type: "call to action",
  length_bucket: "length", slot: "posting time", story_structure: "story structure",
};

/** Plain reasons a post did well or badly, against the account's own medians on its platform. */
export function whyLines(p: PostFact, norms: PlatformNorms | undefined, featureLines: readonly { dimension: string; value: string; lift: number | null; sufficient: boolean }[] = []): string[] {
  const out: { score: number; text: string }[] = [];
  const cmp = (label: string, v: number | null, m: number | null, fmt: (n: number) => string) => {
    if (v === null || m === null || m <= 0) return;
    const r = v / m;
    if (r >= 1.3) out.push({ score: r, text: `${label} ${fmt(v)}, ${r.toFixed(1)}× your usual ${fmt(m)}` });
    else if (r <= 0.7) out.push({ score: 1 / Math.max(r, 0.01), text: `${label} ${fmt(v)}, under your usual ${fmt(m)}` });
  };
  const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
  cmp("Send rate", p.rates.sendRate, norms?.medianSendRate ?? null, pct);
  cmp("Follows per 1k views", p.rates.followsPer1k, norms?.medianFollowsPer1k ?? null, (n) => n.toFixed(1));
  cmp("Engagement", p.rates.engagementPerView, norms?.medianEngagement ?? null, pct);
  cmp("3-second hold", p.hold3s, norms?.medianHold3s ?? null, pct);
  if (p.velocity !== null && (p.velocity >= 1.5 || p.velocity <= 0.6)) {
    out.push({ score: p.velocity >= 1 ? p.velocity : 1 / p.velocity, text: p.velocity >= 1 ? `Fast start: ${p.velocity.toFixed(1)}× your usual first-day views` : `Slow start: ${p.velocity.toFixed(1)}× your usual first-day views` });
  }
  if (p.funnel.leads > 0) out.push({ score: 1.2 + p.funnel.leads / 10, text: `${p.funnel.leads} lead${p.funnel.leads === 1 ? "" : "s"}${p.funnel.bookings ? ` and ${p.funnel.bookings} booked call${p.funnel.bookings === 1 ? "" : "s"}` : ""} from its link` });
  for (const f of featureLines) {
    if (!f.sufficient || f.lift === null || p.features[f.dimension] !== f.value) continue;
    const what = FEATURE_WORDS[f.dimension] ?? f.dimension.replace(/_/g, " ");
    const value = f.dimension === "angle" ? `"${f.value}"` : f.value.replace(/[_-]+/g, " ");
    if (f.lift >= 1.2) out.push({ score: f.lift, text: `Its ${what} (${value}) usually runs ${f.lift.toFixed(1)}× your typical post` });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4).map((o) => o.text);
}

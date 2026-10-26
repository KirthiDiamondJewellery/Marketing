import { change, median, pooledRate, quantile } from "@attentionos/scoring";
import { loadFeatureStats } from "../attribution.ts";
import { goalPacingReport, type GoalPacing } from "../northStar.ts";
import { DAY_MS, type AnalyticsCtx } from "./ctx.ts";
import { followerGrowth, type FollowerGrowth } from "./accounts.ts";
import { postFacts, whyLines, type PostFact, type PostFacts } from "./posts.ts";

/**
 * The Insights overview: north-star pacing, headline numbers against the previous period, the weekly trend of
 * your typical post against your normal band, follower growth and the best post of the week with why it worked.
 */

export type Kpi = { key: string; label: string; value: number | null; previous: number | null; change: number | null; unit: "count" | "rate" | "x" | "per1k" | "usd"; better: "up" | "down"; n?: number };

export type TrendWeek = {
  start: string;
  posts: number;
  views: number;
  /** Median views per post published that week. */
  medianViews: number | null;
  medianX: number | null;
  engagement: number | null;
  sendRate: number | null;
  followsPer1k: number | null;
  /** The normal band: p25–p75 of per-post views over the 90 days before the week. */
  bandLow: number | null;
  bandMid: number | null;
  bandHigh: number | null;
  leads: number;
};

export type BestPost = { post: PostFact; why: string[]; period: "week" | "month" };

export type Overview = {
  days: number;
  kpis: Kpi[];
  trend: TrendWeek[];
  followers: FollowerGrowth;
  pacing: GoalPacing[];
  best: BestPost | null;
  worst: BestPost | null;
  /** Posts in the window, newest first. */
  posts: PostFact[];
  facts: PostFacts;
  lastCapturedAt: string | null;
};

function kpisFor(cur: readonly PostFact[], prev: readonly PostFact[]): Kpi[] {
  const sum = (ps: readonly PostFact[], f: (p: PostFact) => number | null) => ps.reduce((s, p) => s + (f(p) ?? 0), 0);
  const pooled = (ps: readonly PostFact[], numf: (p: PostFact) => number | null, scale = 1) =>
    pooledRate(ps.map((p) => ({ num: numf(p), den: p.views })), scale).value;
  const inter = (p: PostFact) => (p.likes === null && p.comments === null && p.shares === null && p.saves === null ? null : (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0));
  const sends = (p: PostFact) => (p.shares === null && p.saves === null ? null : (p.shares ?? 0) + (p.saves ?? 0));
  const k = (key: string, label: string, unit: Kpi["unit"], f: (ps: readonly PostFact[]) => number | null, better: "up" | "down" = "up"): Kpi => {
    const r4 = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);
    const value = r4(f(cur));
    const previous = r4(f(prev));
    return { key, label, unit, value, previous, change: change(value, previous), better, n: cur.length };
  };
  return [
    k("views", "Views", "count", (ps) => (ps.length ? sum(ps, (p) => p.views) : null)),
    k("posts", "Posts", "count", (ps) => ps.length),
    k("typical_x", "Typical post", "x", (ps) => median(ps.filter((p) => p.settled).map((p) => p.x))),
    k("engagement", "Engagement rate", "rate", (ps) => pooled(ps, inter)),
    k("send_rate", "Send rate", "rate", (ps) => pooled(ps, sends)),
    k("follows_per_1k", "Follows per 1k views", "per1k", (ps) => pooled(ps, (p) => p.follows, 1000)),
    k("leads", "Leads", "count", (ps) => sum(ps, (p) => p.funnel.leads)),
  ];
}

export async function overview(ctx: AnalyticsCtx, opts: { days?: number; weeks?: number; includeScanned?: boolean } = {}): Promise<Overview> {
  const days = opts.days ?? 30;
  const weeks = opts.weeks ?? 12;
  const now = ctx.now().getTime();
  const facts = await postFacts(ctx, { includeScanned: opts.includeScanned ?? false });
  const all = facts.posts;
  const inRange = (from: number, to: number) => all.filter((p) => {
    const t = Date.parse(p.publishedAt);
    return t >= from && t < to;
  });
  const cur = inRange(now - days * DAY_MS, now + 1);
  const prev = inRange(now - 2 * days * DAY_MS, now - days * DAY_MS);

  const trend: TrendWeek[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = now - i * 7 * DAY_MS;
    const start = end - 7 * DAY_MS;
    const ps = inRange(start, end);
    const prior = inRange(start - 90 * DAY_MS, start).filter((p) => p.settled).map((p) => p.views);
    const enough = prior.filter((v) => v !== null).length >= 5;
    const pooled = (f: (p: PostFact) => number | null, scale = 1) => pooledRate(ps.map((p) => ({ num: f(p), den: p.views })), scale).value;
    trend.push({
      start: new Date(start).toISOString(),
      posts: ps.length,
      views: ps.reduce((s, p) => s + (p.views ?? 0), 0),
      medianViews: median(ps.map((p) => p.views)),
      medianX: median(ps.map((p) => p.x)),
      engagement: pooled((p) => (p.likes === null && p.comments === null ? null : (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0))),
      sendRate: pooled((p) => (p.shares === null && p.saves === null ? null : (p.shares ?? 0) + (p.saves ?? 0))),
      followsPer1k: pooled((p) => p.follows, 1000),
      bandLow: enough ? quantile(prior, 0.25) : null,
      bandMid: enough ? median(prior) : null,
      bandHigh: enough ? quantile(prior, 0.75) : null,
      leads: ps.reduce((s, p) => s + p.funnel.leads, 0),
    });
  }

  const features = await loadFeatureStats(ctx, "90d");
  const pick = (from: number, best: boolean): PostFact | null => {
    const scored = all.filter((p) => p.x !== null && Date.parse(p.publishedAt) >= from);
    if (!scored.length) return null;
    return scored.reduce((a, b) => ((best ? b.x! > a.x! : b.x! < a.x!) ? b : a));
  };
  const weekBest = pick(now - 7 * DAY_MS, true);
  const bestPost = weekBest ?? pick(now - 30 * DAY_MS, true);
  const best: BestPost | null = bestPost ? { post: bestPost, why: whyLines(bestPost, facts.norms[bestPost.platform], features), period: weekBest ? "week" : "month" } : null;
  const worstPost = pick(now - 30 * DAY_MS, false);
  const worst: BestPost | null = worstPost && worstPost.postId !== bestPost?.postId ? { post: worstPost, why: whyLines(worstPost, facts.norms[worstPost.platform], features), period: "month" } : null;

  const [last] = await ctx.sql`select max(captured_at) as at from post_metrics where workspace_id = ${ctx.id}`;
  return {
    days,
    kpis: kpisFor(cur, prev),
    trend,
    followers: await followerGrowth(ctx, Math.max(90, days)),
    pacing: await goalPacingReport(ctx),
    best,
    worst,
    posts: [...cur].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    facts,
    lastCapturedAt: last?.at instanceof Date ? last.at.toISOString() : null,
  };
}


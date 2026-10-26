import "server-only";
import {
  bestSlotsFrom, competitorBenchmarks, learnSettings, overview, postDetail, postFacts,
  type BestSlots, type Overview, type PlatformBenchmark, type PostFact,
} from "@attentionos/module-learn/analytics";
import { featureAttribution, median } from "@attentionos/scoring";
import { insightsCtx, RANGES, type InsightRange } from "@/server/queries/insights";
import { getCreators, getOutliers, getTrends, type Creator, type Outlier, type Trend } from "@/server/queries/research";
import { workspace } from "@/server/workspace";

/**
 * Read models for /analytics (Research + Insights in one place). Own-post numbers come from
 * `@attentionos/module-learn/analytics` with `includeScanned`, so the posts setup read off the owner's public
 * account count from the first day, next to anything published and measured since. Competitor numbers come
 * from the research tables the daily scan fills. Nothing here writes.
 */

export const parseDays = (v: string | undefined, fallback: InsightRange = 30): InsightRange =>
  (RANGES as readonly number[]).includes(Number(v)) ? (Number(v) as InsightRange) : fallback;

const DAY_MS = 86_400_000;
const ABOVE = 1.3;
const BELOW = 0.7;

// ---------------------------------------------------------------------------------------------------------------
// Where the numbers come from
// ---------------------------------------------------------------------------------------------------------------

export type Sources = {
  /** The owner's posts read off their public account (setup, or a later re-read). */
  scan: { at: string; posts: number; accounts: { platform: string; handle: string; posts: number }[] } | null;
  /** Posts published or imported through the publishing service, with captured numbers. */
  measured: { posts: number; lastCapturedAt: string | null };
  /** The last competitor scan. */
  competitorsAt: string | null;
  competitors: number;
};

export async function getSources(): Promise<Sources> {
  const ws = workspace();
  const scan = await ws.sql<{ platform: string; handle: string; posts: number; at: Date | null }[]>`
    select tc.platform, tc.handle, count(e.id)::int as posts, max(e.last_updated_at) as at
      from tracked_creators tc join external_posts e on e.tracked_creator_id = tc.id and e.workspace_id = tc.workspace_id
     where tc.workspace_id = ${ws.id} and tc.tier = 'own'
     group by tc.platform, tc.handle order by posts desc`;
  const [m] = await ws.sql<{ posts: number; last: Date | null; comp_at: Date | null; comps: number }[]>`
    select (select count(distinct p.id)::int from posts p join post_metrics pm on pm.post_id = p.id and pm.workspace_id = p.workspace_id
             where p.workspace_id = ${ws.id} and p.status = 'published') as posts,
           (select max(captured_at) from post_metrics where workspace_id = ${ws.id}) as last,
           (select max(last_scanned_at) from tracked_creators where workspace_id = ${ws.id} and tier <> 'own') as comp_at,
           (select count(*)::int from tracked_creators where workspace_id = ${ws.id} and tier <> 'own' and active) as comps`;
  const at = scan.reduce<Date | null>((a, r) => (r.at && (!a || r.at > a) ? r.at : a), null);
  return {
    scan: scan.length && at ? { at: at.toISOString(), posts: scan.reduce((s, r) => s + r.posts, 0), accounts: scan.map((r) => ({ platform: r.platform, handle: r.handle, posts: r.posts })) } : null,
    measured: { posts: m?.posts ?? 0, lastCapturedAt: m?.last?.toISOString() ?? null },
    competitorsAt: m?.comp_at?.toISOString() ?? null,
    competitors: m?.comps ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------------------------

export type Versus = "above" | "below" | "normal" | null;

/** Serializable post row for client components. */
export type AnalyticsPost = {
  id: string;
  source: "published" | "scan";
  title: string;
  hook: string | null;
  platform: string;
  publishedAt: string;
  url: string | null;
  thumbnailUrl: string | null;
  durationS: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  engagement: number | null;
  x: number | null;
  versus: Versus;
  settled: boolean;
};

export const versusOf = (x: number | null, settled = true): Versus => (x === null || !settled ? null : x >= ABOVE ? "above" : x <= BELOW ? "below" : "normal");

export function toAnalyticsPost(p: PostFact): AnalyticsPost {
  return {
    id: p.postId,
    source: p.source,
    title: p.title ?? "Untitled post",
    hook: p.scan?.spokenHook ?? null,
    platform: p.platform,
    publishedAt: p.publishedAt,
    url: p.url,
    thumbnailUrl: p.scan?.thumbnailUrl ?? null,
    durationS: p.durationS,
    views: p.views,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    saves: p.saves,
    engagement: p.rates.engagementPerView,
    x: p.x,
    versus: versusOf(p.x, p.settled),
    settled: p.settled,
  };
}

export async function getFacts() {
  return postFacts(insightsCtx(), { includeScanned: true });
}

export async function getPosts(days: number | null): Promise<AnalyticsPost[]> {
  const { posts } = await getFacts();
  const since = days ? Date.now() - days * DAY_MS : null;
  return posts
    .filter((p) => p.data !== "none" && (since === null || Date.parse(p.publishedAt) >= since))
    .map(toAnalyticsPost)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function getPost(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return postDetail(insightsCtx(), id, { includeScanned: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------------------------

export type Headline = {
  key: "followers" | "avg_views" | "engagement" | "per_week";
  label: string;
  value: number | null;
  previous: number | null;
  unit: "count" | "rate" | "number";
  hint?: string;
};

export type AnalyticsOverview = {
  days: number;
  ov: Overview;
  headline: Headline[];
  best: AnalyticsPost | null;
  bestWhy: string[];
  /** Posts in the window (with numbers), newest first. */
  recent: AnalyticsPost[];
  /** The account has any posts with numbers at all. */
  hasPosts: boolean;
};

const mean = (xs: (number | null)[]) => {
  const v = xs.filter((n): n is number => n !== null);
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
};

export async function getOverview(days: InsightRange): Promise<AnalyticsOverview> {
  const ov = await overview(insightsCtx(), { days, weeks: 12, includeScanned: true });
  const now = Date.now();
  const all = ov.facts.posts.filter((p) => p.data !== "none");
  const inRange = (from: number, to: number) => all.filter((p) => Date.parse(p.publishedAt) >= from && Date.parse(p.publishedAt) < to);
  const cur = inRange(now - days * DAY_MS, now + 1);
  const prev = inRange(now - 2 * days * DAY_MS, now - days * DAY_MS);
  const eng = ov.kpis.find((k) => k.key === "engagement");
  const typical = median(cur.map((p) => p.views));
  const headline: Headline[] = [
    {
      key: "followers",
      label: "Followers",
      value: ov.followers.current,
      previous: ov.followers.current !== null && ov.followers.delta30 !== null ? ov.followers.current - ov.followers.delta30 : null,
      unit: "count",
      ...(ov.followers.current === null ? { hint: "Shows after your next account scan, or once Zernio is connected" } : {}),
    },
    { key: "avg_views", label: "Average views per post", value: mean(cur.map((p) => p.views)), previous: mean(prev.map((p) => p.views)), unit: "count", ...(typical !== null ? { hint: `Typical post: ${Math.round(typical).toLocaleString("en-US")}` } : {}) },
    { key: "engagement", label: "Engagement rate", value: eng?.value ?? null, previous: eng?.previous ?? null, unit: "rate", hint: "Likes, comments, shares and saves per view" },
    { key: "per_week", label: "Posts per week", value: cur.length / (days / 7), previous: prev.length / (days / 7), unit: "number" },
  ];
  // Best in the window: the post furthest above your normal, else the most viewed.
  const ranked = [...cur].sort((a, b) => (b.x ?? -1) - (a.x ?? -1) || (b.views ?? -1) - (a.views ?? -1));
  const bestFact = ranked[0] ?? null;
  return {
    days,
    ov,
    headline,
    best: bestFact ? toAnalyticsPost(bestFact) : null,
    bestWhy: bestFact && ov.best?.post.postId === bestFact.postId ? ov.best.why : [],
    recent: cur.map(toAnalyticsPost).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    hasPosts: all.length > 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What's working
// ---------------------------------------------------------------------------------------------------------------

const WORKING_DIMENSIONS = ["hook_pattern", "format", "lane", "angle", "length_bucket", "slot"] as const;

export type WorkingRow = { dimension: string; value: string; n: number; lift: number; medianX: number; verdict: string };

export type Working = {
  /** Settled posts with a score against your normal (what every finding here is built from). */
  scored: number;
  minN: number;
  /** Choices that beat your normal with enough posts behind them, best first. */
  winners: WorkingRow[];
  /** Choices that run under your normal with enough posts behind them. */
  losers: WorkingRow[];
  /** Your posts that ran well above your normal, best first. */
  topPosts: AnalyticsPost[];
  slots: BestSlots;
  /** Posts still needed before a finding is possible (0 when there is one). */
  needMore: number;
};

export async function getWorking(): Promise<Working> {
  const ctx = insightsCtx();
  const { posts } = await getFacts();
  const minN = learnSettings(ctx).attribution.minN;
  const since = Date.now() - 120 * DAY_MS;
  const settled = posts.filter((p) => p.settled && p.x !== null && Date.parse(p.publishedAt) >= since);
  const attr = featureAttribution(settled.map((p) => ({ x: p.x, features: p.features })), { minN, confidence: learnSettings(ctx).attribution.confidence, dimensions: WORKING_DIMENSIONS });
  const rows = attr.stats
    .filter((s) => s.sufficient && s.lift !== null && s.medianX !== null)
    .map((s) => ({ dimension: s.dimension, value: s.value, n: s.n, lift: s.lift!, medianX: s.medianX!, verdict: s.verdict }));
  return {
    scored: settled.length,
    minN,
    winners: rows.filter((r) => r.lift >= 1.1).sort((a, b) => b.lift - a.lift).slice(0, 8),
    losers: rows.filter((r) => r.lift <= 0.9).sort((a, b) => a.lift - b.lift).slice(0, 4),
    topPosts: settled.filter((p) => p.x! >= ABOVE).sort((a, b) => b.x! - a.x!).slice(0, 6).map(toAnalyticsPost),
    slots: bestSlotsFrom(ctx, posts.filter((p) => Date.parse(p.publishedAt) >= since)),
    needMore: Math.max(0, minN * 2 - settled.length),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------------------------------------------

export type CompetitorsView = {
  benches: PlatformBenchmark[];
  creators: Creator[];
  outliers: Outlier[];
  trends: Trend[];
};

export async function getCompetitorsView(days: InsightRange): Promise<CompetitorsView> {
  const ctx = insightsCtx();
  const { posts } = await getFacts();
  const window = days === 7 ? "7d" : days === 30 ? "30d" : "90d";
  const [benches, creators, outliers, trends] = await Promise.all([
    competitorBenchmarks(ctx, posts, { days: Math.max(days, 30), outlierDays: Math.max(days, 30) }),
    getCreators(),
    getOutliers({ window }),
    getTrends(),
  ]);
  return {
    benches,
    creators: creators.filter((c) => c.active),
    outliers: outliers.items.slice(0, 12),
    trends: trends.filter((t) => ["new", "shortlisted", "kit"].includes(t.status)).slice(0, 5),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Extra reports (shown as small links only when they have something)
// ---------------------------------------------------------------------------------------------------------------

export async function getMoreLinks(): Promise<{ href: string; label: string }[]> {
  const ws = workspace();
  const [r] = await ws.sql<{ funnel: boolean; published: boolean }[]>`
    select exists (select 1 from funnel_events where workspace_id = ${ws.id}) or exists (select 1 from contacts where workspace_id = ${ws.id} and utm_content is not null) as funnel,
           exists (select 1 from post_metrics where workspace_id = ${ws.id}) as published`;
  return [
    ...(r?.published ? [{ href: "/insights/report", label: "Weekly report" }] : []),
    ...(r?.funnel ? [{ href: "/insights/funnel", label: "Leads and sales" }] : []),
  ];
}

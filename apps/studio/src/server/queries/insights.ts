import "server-only";
import {
  bestSlots, competitorBenchmarks, funnelReport, learnSettings, loadFeatureStats, overview, postDetail, postFacts, weeklyReport,
  type AnalyticsCtx, type AttributionMetric, type PostFact, type SlotMetric, type StoredFeatureStat,
} from "@attentionos/module-learn/analytics";
import { workspace } from "@/server/workspace";

/**
 * Insights reads. Every number comes from `@attentionos/module-learn/analytics`, the same functions the
 * Analyst's MCP tools call, so the dashboard and the agents never disagree. Nothing here writes.
 */

export function insightsCtx(): AnalyticsCtx {
  const ws = workspace();
  return { id: ws.id, sql: ws.sql, config: ws.config, now: () => new Date() };
}

export const RANGES = [7, 30, 90] as const;
export type InsightRange = (typeof RANGES)[number];
export const parseRange = (v: string | undefined, fallback: InsightRange = 30): InsightRange =>
  (RANGES as readonly number[]).includes(Number(v)) ? (Number(v) as InsightRange) : fallback;

export const WINDOWS = ["30d", "90d", "all"] as const;
export type InsightWindow = (typeof WINDOWS)[number];

export const NORTH_STAR_LABEL: Record<string, string> = {
  leads_per_week: "Leads per week",
  follows_per_post: "Follows per post",
  booked_calls_per_week: "Booked calls per week",
  skip_rate: "Skip rate",
  revenue_per_week: "Revenue per week",
};

// ---------------------------------------------------------------------------------------------------------------
// Serializable post rows for client components
// ---------------------------------------------------------------------------------------------------------------

export type PostRow = {
  id: string;
  contentId: string | null;
  title: string;
  platform: string;
  publishedAt: string;
  url: string | null;
  views: number | null;
  x: number | null;
  velocity: number | null;
  hold3s: number | null;
  sendRate: number | null;
  engagement: number | null;
  followsPer1k: number | null;
  leads: number;
  bookings: number;
  revenue: number;
  flag: "breakout" | "flop" | null;
  settled: boolean;
  variants: number;
  lane: string | null;
  hook: string | null;
};

export function toRow(p: PostFact): PostRow {
  return {
    id: p.postId,
    contentId: p.contentId,
    title: p.title ?? "Untitled post",
    platform: p.platform,
    publishedAt: p.publishedAt,
    url: p.url,
    views: p.views,
    x: p.x,
    velocity: p.velocity,
    hold3s: p.hold3s,
    sendRate: p.rates.sendRate,
    engagement: p.rates.engagementPerView,
    followsPer1k: p.rates.followsPer1k,
    leads: p.funnel.leads,
    bookings: p.funnel.bookings,
    revenue: p.funnel.revenue,
    flag: p.flag,
    settled: p.settled,
    variants: p.variants,
    lane: p.features.lane ?? null,
    hook: p.features.hook_pattern ?? null,
  };
}

export async function getOverview(days: InsightRange) {
  return overview(insightsCtx(), { days, weeks: 12 });
}

export async function getPosts(days: InsightRange | null) {
  const ctx = insightsCtx();
  const { posts } = await postFacts(ctx, days ? { sinceDays: days } : {});
  return posts.map(toRow).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** Not used yet: no Studio page calls this. Kept for a later release. */
export async function getPostDetail(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return postDetail(insightsCtx(), id);
}

// ---------------------------------------------------------------------------------------------------------------
// What's working
// ---------------------------------------------------------------------------------------------------------------

export const DIMENSION_ORDER = ["hook_pattern", "lane", "format", "length_bucket", "cta_type", "funnel_stage", "story_structure", "angle", "slot"] as const;

export type FeatureRow = {
  dimension: string;
  value: string;
  n: number;
  medianX: number | null;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  sufficient: boolean;
  verdict: StoredFeatureStat["verdict"];
};

export async function featureStats(window: InsightWindow, metric: AttributionMetric) {
  const ctx = insightsCtx();
  const minN = learnSettings(ctx).attribution.minN;
  const stats = await loadFeatureStats(ctx, window, minN, metric);
  const byDim = new Map<string, FeatureRow[]>();
  let computedAt: string | null = null;
  for (const s of stats) {
    if (s.computedAt && (!computedAt || s.computedAt > computedAt)) computedAt = s.computedAt;
    const row: FeatureRow = { dimension: s.dimension, value: s.value, n: s.n, medianX: s.medianX, lift: s.lift, ciLow: s.ciLow, ciHigh: s.ciHigh, sufficient: s.sufficient && s.medianX !== null, verdict: s.verdict };
    byDim.set(s.dimension, [...(byDim.get(s.dimension) ?? []), row]);
  }
  const order = (d: string) => {
    const i = (DIMENSION_ORDER as readonly string[]).indexOf(d);
    return i === -1 ? 99 : i;
  };
  const dimensions = [...byDim.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([dimension, rows]) => ({ dimension, rows: rows.sort((a, b) => Number(b.sufficient) - Number(a.sufficient) || (b.medianX ?? 0) - (a.medianX ?? 0)) }));
  return { minN, dimensions, computedAt, confidence: learnSettings(ctx).attribution.confidence };
}

export async function getSlots(metric: SlotMetric, platform: string | null) {
  return bestSlots(insightsCtx(), { metric, days: 120, platform });
}

/** Not used yet: no Studio page calls this. Kept for a later release. */
export async function getCompetitors(days: InsightRange) {
  const ctx = insightsCtx();
  const { posts } = await postFacts(ctx);
  return competitorBenchmarks(ctx, posts, { days: Math.max(days, 30), outlierDays: Math.max(days, 30) });
}

export async function getFunnel(days: InsightRange) {
  const ctx = insightsCtx();
  const { posts } = await postFacts(ctx);
  const report = await funnelReport(ctx, posts, days);
  const byId = new Map(posts.map((p) => [p.postId, p]));
  const rows = report.byPost
    .map((r) => ({ ...r, post: byId.get(r.postId) ? toRow(byId.get(r.postId)!) : null }))
    .filter((r) => r.post)
    .sort((a, b) => b.counts.revenue - a.counts.revenue || b.counts.bookings - a.counts.bookings || b.counts.leads - a.counts.leads || (b.views ?? 0) - (a.views ?? 0));
  return { report, rows };
}

export async function getReport() {
  return weeklyReport(insightsCtx());
}

// ---------------------------------------------------------------------------------------------------------------
// Post-mortems
// ---------------------------------------------------------------------------------------------------------------

export type PostMortem = {
  id: string;
  postId: string | null;
  kind: "breakout" | "flop" | "new_best" | "manual";
  x: number | null;
  bodyMd: string;
  lessons: string[];
  createdAt: string;
  title: string | null;
  platform: string | null;
  publishedAt: string | null;
};

export async function postMortems(limit = 12): Promise<PostMortem[]> {
  const ws = workspace();
  const rows = await ws.sql<
    { id: string; post_id: string | null; kind: PostMortem["kind"]; x_score: string | null; body_md: string; lessons: unknown; created_at: Date; title: string | null; platform: string | null; published_at: Date | null }[]
  >`
    select pm.id, pm.post_id, pm.kind, pm.x_score, pm.body_md, pm.lessons, pm.created_at, c.title, p.platform, p.published_at
      from post_mortems pm
      left join posts p on p.id = pm.post_id and p.workspace_id = pm.workspace_id
      left join content c on c.id = p.content_id and c.workspace_id = pm.workspace_id
     where pm.workspace_id = ${ws.id}
     order by pm.created_at desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    kind: r.kind,
    x: r.x_score === null ? null : Number(r.x_score),
    bodyMd: r.body_md,
    lessons: Array.isArray(r.lessons) ? r.lessons.map((l) => (typeof l === "string" ? l : String((l as { text?: unknown })?.text ?? ""))).filter(Boolean) : [],
    createdAt: r.created_at.toISOString(),
    title: r.title,
    platform: r.platform,
    publishedAt: r.published_at?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Cost watch
// ---------------------------------------------------------------------------------------------------------------

export type CostLine = { category: string; label: string; period: "day" | "month" | null; spent: number; budget: number | null };

export type CostWatch = {
  lines: CostLine[];
  monthTotal: number;
  byCategoryMonth: { category: string; spent: number }[];
  /** LLM spend per local day, oldest first, last 14 days. */
  daily: { day: string; usd: number }[];
};

export async function costWatch(): Promise<CostWatch> {
  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  const b = ws.config.budgets;
  const rows = await ws.sql<{ category: string; today: string; month: string }[]>`
    select category,
           coalesce(sum(amount_micro) filter (where ts >= date_trunc('day', now() at time zone ${tz}) at time zone ${tz}), 0)::text as today,
           coalesce(sum(amount_micro) filter (where ts >= date_trunc('month', now() at time zone ${tz}) at time zone ${tz}), 0)::text as month
      from cost_ledger where workspace_id = ${ws.id} and ts > now() - interval '62 days'
     group by category`;
  const daily = await ws.sql<{ day: string; micro: string }[]>`
    select to_char(d, 'YYYY-MM-DD') as day, coalesce(sum(c.amount_micro), 0)::text as micro
      from generate_series(date_trunc('day', now() at time zone ${tz}) - interval '13 days', date_trunc('day', now() at time zone ${tz}), interval '1 day') d
      left join cost_ledger c on c.workspace_id = ${ws.id} and c.category = 'llm'
           and c.ts >= d at time zone ${tz} and c.ts < (d + interval '1 day') at time zone ${tz}
     group by d order by d`;
  const get = (cat: string, k: "today" | "month") => Number(rows.find((r) => r.category === cat)?.[k] ?? 0) / 1e6;
  const lines: CostLine[] = [
    { category: "llm", label: "AI writing and editing", period: "day", spent: get("llm", "today"), budget: b.dailyUsd },
    { category: "scraping", label: "Competitor research", period: "month", spent: get("scraping", "month"), budget: b.scrapingMonthlyUsd },
    { category: "images", label: "Generated images", period: "day", spent: get("images", "today"), budget: b.imagesDailyUsd },
    { category: "publishing", label: "Publishing", period: "month", spent: get("publishing", "month"), budget: null },
  ];
  const byCategoryMonth = rows.map((r) => ({ category: r.category, spent: Number(r.month) / 1e6 })).filter((r) => r.spent > 0).sort((a, b2) => b2.spent - a.spent);
  return {
    lines,
    monthTotal: byCategoryMonth.reduce((s, r) => s + r.spent, 0),
    byCategoryMonth,
    daily: daily.map((d) => ({ day: d.day, usd: Number(d.micro) / 1e6 })),
  };
}

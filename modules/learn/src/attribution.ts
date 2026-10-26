import type { WorkspaceContext } from "@attentionos/core";
import { blendWeights, featureAttribution, verdictOf, type AttributionResult, type FeatureStat, type FeatureWeights } from "@attentionos/scoring";
import { iso, num, type AnalyticsCtx } from "./analytics/ctx.ts";
import { postFacts, type PostFact } from "./analytics/posts.ts";
import { learnSettings } from "./settings.ts";

/**
 * Feature attribution into `feature_stats` and the weights API the Strategist reads.
 * Own windows: "30d", "90d", "all". Competitor signals are stored under "competitor:90d".
 * Outcome metrics: "x" (vs your normal; the one the weights use), "send_rate" and "follows_per_1k".
 */

export const OWN_WINDOWS = { "30d": 30, "90d": 90, all: null } as const;
export type OwnWindow = keyof typeof OWN_WINDOWS;
export const COMPETITOR_WINDOW = "competitor:90d";

export const ATTRIBUTION_METRICS = {
  x: { label: "", format: (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100) / 100}x`), value: (p: PostFact) => p.x },
  send_rate: { label: "send rate", format: (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(2)}%`), value: (p: PostFact) => p.rates.sendRate },
  follows_per_1k: { label: "follows per 1k views", format: (v: number | null) => (v === null ? "n/a" : (Math.round(v * 10) / 10).toFixed(1)), value: (p: PostFact) => p.rates.followsPer1k },
} as const;
export type AttributionMetric = keyof typeof ATTRIBUTION_METRICS;
export const ATTRIBUTION_METRIC_KEYS = Object.keys(ATTRIBUTION_METRICS) as AttributionMetric[];

async function replaceWindow(ws: AnalyticsCtx, window: string, metric: string, res: AttributionResult): Promise<void> {
  await ws.sql.begin(async (tx) => {
    await tx`delete from feature_stats where workspace_id = ${ws.id} and time_window = ${window} and metric = ${metric}`;
    for (const s of res.stats) {
      await tx`
        insert into feature_stats (workspace_id, dimension, value, time_window, metric, n, median_x, lift, ci_low, ci_high, computed_at)
        values (${ws.id}, ${s.dimension}, ${s.value}, ${window}, ${metric}, ${s.n}, ${s.medianX}, ${s.lift}, ${s.ciLow}, ${s.ciHigh}, ${ws.now()})`;
    }
  });
}

export type AttributionRun = { windows: Record<string, { n: number; overallMedian: number | null; values: number; gaps: string[] }>; competitor: { n: number; values: number } };

export async function runAttribution(ws: WorkspaceContext): Promise<AttributionRun> {
  const s = learnSettings(ws).attribution;
  const { posts } = await postFacts(ws, { persist: true });
  const now = ws.now().getTime();
  const out: AttributionRun = { windows: {}, competitor: { n: 0, values: 0 } };
  for (const [window, days] of Object.entries(OWN_WINDOWS)) {
    const inWindow = posts.filter((p) => p.settled && (days === null || now - new Date(p.publishedAt).getTime() <= days * 86_400_000));
    for (const metric of ATTRIBUTION_METRIC_KEYS) {
      const def = ATTRIBUTION_METRICS[metric];
      const res = featureAttribution(inWindow.map((p) => ({ x: def.value(p), features: p.features })), { minN: s.minN, confidence: s.confidence, metricLabel: def.label, format: def.format });
      await replaceWindow(ws, window, metric, res);
      if (metric === "x") out.windows[window] = { n: res.n, overallMedian: res.overallMedian, values: res.stats.length, gaps: res.gaps };
    }
  }

  // Competitor signals: outliers and non-outliers alike, by vision-tagged format and hook pattern.
  const comp = await ws.sql`
    select x_score, tags from external_posts
     where workspace_id = ${ws.id} and x_score is not null and not is_meme
       and published_at >= ${new Date(now - 90 * 86_400_000)}`;
  const compRes = featureAttribution(comp.map((r) => {
    const tags = (r.tags as Record<string, unknown> | null) ?? {};
    return { x: num(r.x_score), features: { format: typeof tags.format === "string" ? tags.format : null, hook_pattern: typeof tags.hook_pattern === "string" ? tags.hook_pattern : null } };
  }), { minN: s.minN, confidence: s.confidence, dimensions: ["format", "hook_pattern"] });
  await replaceWindow(ws, COMPETITOR_WINDOW, "x", compRes);
  out.competitor = { n: compRes.n, values: compRes.stats.length };
  return out;
}

const DIMENSION_WORDS: Record<string, string> = {
  hook_pattern: "hook pattern", lane: "lane", format: "format", angle: "angle", funnel_stage: "funnel stage", cta_type: "CTA",
  length_bucket: "length", slot: "posting slot", story_structure: "story structure",
};

export type StoredFeatureStat = FeatureStat & { metric: string; computedAt: string | null };

export async function loadFeatureStats(ws: AnalyticsCtx, window: string, minN?: number, metric: string = "x"): Promise<StoredFeatureStat[]> {
  const settings = learnSettings(ws).attribution;
  const min = minN ?? settings.minN;
  const def = ATTRIBUTION_METRICS[metric as AttributionMetric] ?? ATTRIBUTION_METRICS.x;
  const rows = await ws.sql`
    select dimension, value, n, median_x, lift, ci_low, ci_high, computed_at from feature_stats
     where workspace_id = ${ws.id} and time_window = ${window} and metric = ${metric}
     order by dimension, lift desc nulls last, value`;
  return rows.map((r) => {
    const n = Number(r.n);
    const sufficient = n >= min;
    const medianX = num(r.median_x);
    const lift = num(r.lift);
    const ciLow = num(r.ci_low);
    const ciHigh = num(r.ci_high);
    // overall = median / lift; the range is "clear" when it excludes the overall median.
    const overall = medianX !== null && lift !== null && lift > 0 ? medianX / lift : null;
    const clear = sufficient && overall !== null && ciLow !== null && ciHigh !== null && (ciLow > overall || ciHigh < overall);
    const label = `${DIMENSION_WORDS[r.dimension as string] ?? String(r.dimension).replace(/_/g, " ")} "${r.value as string}"`;
    const metricWord = def.label ? `${def.label} ` : "";
    return {
      dimension: r.dimension as string,
      value: r.value as string,
      metric,
      n,
      medianX,
      lift,
      ciLow,
      ciHigh,
      sufficient,
      clear,
      liftLow: overall && ciLow !== null ? Math.round((ciLow / overall) * 1000) / 1000 : null,
      liftHigh: overall && ciHigh !== null ? Math.round((ciHigh / overall) * 1000) / 1000 : null,
      verdict: verdictOf({ sufficient, clear, lift, ciLow }, overall),
      line: sufficient
        ? `${label}: median ${metricWord}${def.format(medianX)} (lift ${lift}x, n=${n}${ciLow !== null ? `, range ${def.format(ciLow)}–${def.format(ciHigh)}` : ""})`
        : `GAP: ${label} has ${n} post${n === 1 ? "" : "s"} (need ${min}). Not enough data to judge yet.`,
      computedAt: iso(r.computed_at),
    };
  });
}

export type Weights = {
  /** 0 = competitor signals only, 1 = own data only. */
  ownShare: number;
  ownPosts: number;
  /** Share of picks that should explore regardless of weights. */
  explore: number;
  weights: FeatureWeights;
  source: "competitor" | "blend" | "own" | "none";
};

/**
 * Weights for the Strategist's picks and the Copywriter's hook selection.
 * `weights[dimension][value]` is a multiplier around 1; unknown values are 1.
 */
export async function getWeights(ws: AnalyticsCtx): Promise<Weights> {
  const s = learnSettings(ws).weights;
  let own = await loadFeatureStats(ws, "90d");
  if (own.length === 0) own = await loadFeatureStats(ws, "all");
  const competitor = await loadFeatureStats(ws, COMPETITOR_WINDOW);
  const [r] = await ws.sql`
    select count(*)::int as n from posts p
     where p.workspace_id = ${ws.id} and p.status = 'published' and p.variant_of is null
       and exists (select 1 from post_metrics m where m.post_id = p.id and m.workspace_id = p.workspace_id)`;
  const ownPosts = Number(r?.n ?? 0);
  const blended = blendWeights({ own, competitor, ownPosts, fullTrustAt: s.fullTrustAt, min: s.min, max: s.max });
  const hasOwn = own.some((x) => x.sufficient);
  const hasComp = competitor.some((x) => x.sufficient);
  const source = !hasOwn && !hasComp ? "none" : blended.ownShare >= 1 && hasOwn ? "own" : blended.ownShare === 0 || !hasOwn ? "competitor" : "blend";
  return { ownShare: blended.ownShare, ownPosts, explore: s.explore, weights: blended.weights, source };
}

/**
 * Weights for ONE dimension, e.g. `getFeatureWeights(ws, "hook_pattern")` → `{ question: 1.4, list: 0.7 }`.
 * Values are multipliers around 1 (missing value = 1), already blended between competitor and own data and
 * clamped to [0.5, 2]. They do NOT include exploration: callers pick with
 * `pickWeighted(options, rand, (await getWeights(ws)).explore)` from `@attentionos/scoring`, which explores
 * uniformly 20% of the time by default.
 */
export async function getFeatureWeights(ws: AnalyticsCtx, dimension: string): Promise<Record<string, number>> {
  return (await getWeights(ws)).weights[dimension] ?? {};
}

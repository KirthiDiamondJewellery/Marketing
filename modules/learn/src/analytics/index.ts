/**
 * `@attentionos/module-learn/analytics`: the read side of Learn without jobs or provider wiring, safe to import from
 * Studio. Insights and the agents' MCP tools call these same functions, so they always show the same numbers.
 */
export { num, iso, aosOf, retentionAt, type AnalyticsCtx } from "./ctx.ts";
export { postFacts, whyLines, hold3sOf, type PostFact, type PostFacts, type PlatformNorms } from "./posts.ts";
export { overview, type Overview, type Kpi, type TrendWeek, type BestPost } from "./overview.ts";
export { postDetail, type PostDetail, type SeriesPoint, type CurvePoint } from "./detail.ts";
export { bestSlots, bestSlotsFrom, SLOT_METRICS, type BestSlots, type SlotMetric } from "./slots.ts";
export { competitorBenchmarks, type PlatformBenchmark, type CompetitorOutlier } from "./benchmarks.ts";
export { funnelReport, funnelByPost, funnelSources, loadFunnelEvents, recordFunnelEvents, funnelEventInput, type FunnelReport, type FunnelEventInput } from "./funnel.ts";
export { followerGrowth, type FollowerGrowth, type FollowerPoint } from "./accounts.ts";
export { weeklyReport, type WeeklyReport } from "./report.ts";
export { goalPacingReport, northStar, measure, NORTH_STAR_METRICS, type GoalPacing, type NorthStarReading } from "../northStar.ts";
export { loadFeatureStats, ATTRIBUTION_METRICS, ATTRIBUTION_METRIC_KEYS, type AttributionMetric, type StoredFeatureStat } from "../attribution.ts";
export { computeOwnScores, hasNumbers, postUrlKey, type OwnPostScore, type ScanInfo } from "../metrics.ts";
export { learnSettings } from "../settings.ts";

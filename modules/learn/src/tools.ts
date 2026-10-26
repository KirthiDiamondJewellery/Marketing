import { z } from "zod";
import { compact, defineNativeJob, defineTool, ToolError } from "@attentionos/core";
import { PLATFORMS } from "@attentionos/core";
import { blockLabel, median, round, FEATURE_DIMENSIONS, WEEKDAYS } from "@attentionos/scoring";
import { competitorBenchmarks } from "./analytics/benchmarks.ts";
import { postDetail } from "./analytics/detail.ts";
import { funnelEventInput, funnelReport, recordFunnelEvents } from "./analytics/funnel.ts";
import { overview } from "./analytics/overview.ts";
import { postFacts, type PostFact } from "./analytics/posts.ts";
import { bestSlots } from "./analytics/slots.ts";
import { COMPETITOR_WINDOW, getWeights, loadFeatureStats, runAttribution } from "./attribution.ts";
import { buildWeeklyBriefing } from "./briefing.ts";
import { goalPacingReport, northStar } from "./northStar.ts";
import { checkPostMortemBody, listPostMortems, postContext, postMortemBodySchema, savePostMortem } from "./postMortems.ts";

export const attributionJob = defineNativeJob({
  kind: "native",
  id: "learn.attribution",
  agent: "analyst",
  description: "Works out which lanes, hooks, formats, angles, CTAs, lengths and posting slots lift your results, with honest gaps where data is thin.",
  input: z.object({}),
  async run(ctx) {
    const r = await runAttribution(ctx.ws);
    const w = r.windows["90d"]!;
    await ctx.progress(`Updated what's working from ${w.n} post${w.n === 1 ? "" : "s"} (last 90 days)${w.gaps.length ? `; ${w.gaps.length} choice${w.gaps.length === 1 ? " needs" : "s need"} more posts before we can judge` : ""}`);
    return r;
  },
});

const r3 = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? undefined : round(v, d));

export const performanceSummaryTool = defineTool({
  name: "learn_get_performance_summary",
  description:
    "How the user's own posts are doing against their own normal: headline numbers vs the previous period (views, typical x, engagement, send rate, follows per 1k views, leads), " +
    "best and weakest posts with why, follower growth, north-star pacing and per-platform baselines. 1.0x = the account's usual post. Use before planning or when asked how content is performing.",
  input: z.object({ days: z.number().int().positive().max(365).default(30) }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const ov = await overview(ws, { days: input.days, weeks: 8, includeScanned: true });
    const scored = ov.posts.filter((p) => p.x !== null).sort((a, b) => b.x! - a.x!);
    const brief = (p: PostFact) => compact({
      postId: p.postId, title: p.title, platform: p.platform, url: p.url, published: p.publishedAt.slice(0, 10), x: p.x, views: p.views,
      sendRate: r3(p.rates.sendRate, 4), followsPer1k: r3(p.rates.followsPer1k, 2), velocity: p.velocity, leads: p.funnel.leads || undefined,
      lane: p.features.lane, hook: p.features.hook_pattern, flag: p.flag ?? undefined, trialVariants: p.variants > 1 ? p.variants : undefined,
    });
    return compact({
      days: input.days,
      posts: ov.posts.length,
      scored: scored.length,
      typicalX: median(scored.map((p) => p.x)),
      kpis: ov.kpis.map((k) => compact({ metric: k.label, value: r3(k.value, 4), previous: r3(k.previous, 4), change: k.change })),
      best: ov.best ? { ...brief(ov.best.post), why: ov.best.why } : undefined,
      top: scored.slice(0, 3).map(brief),
      weakest: scored.length > 3 ? scored.slice(-3).reverse().map(brief) : undefined,
      followers: ov.followers.gap ? ov.followers.gap : compact({ current: ov.followers.current, last7Days: ov.followers.delta7, previous7Days: ov.followers.previous7, last30Days: ov.followers.delta30 }),
      pacing: ov.pacing.map((g) => compact({ goal: g.label, northStar: g.isNorthStar, status: g.pace.status, line: g.pace.line, gap: g.gap })),
      baselines: Object.fromEntries(Object.entries(ov.facts.baselines).map(([k, b]) => [k, compact({ views: b!.views, comments: b!.comments, posts: b!.n, enough: b!.sufficient })])),
      usual: ov.facts.norms,
      northStar: await northStar(ws),
      note: scored.length < ov.posts.length ? "Posts without an x need more history on that platform (5 mature posts) or haven't been measured yet." : undefined,
    });
  },
});

export const postDetailTool = defineTool({
  name: "learn_get_post_detail",
  description:
    "One post in full: every number and rate, x vs the account's normal, velocity (first-day views vs usual), 3-second hold, its views at each capture against the account's usual curve, " +
    "retention curve vs usual, the funnel it drove (clicks, leads, bookings, revenue), why it did what it did, and its post-mortems.",
  input: z.object({ postId: z.string().uuid() }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const d = await postDetail(ws, input.postId, { includeScanned: true });
    if (!d) throw new ToolError("No published post with that id", "Use learn_get_performance_summary to find post ids");
    const p = d.post;
    return compact({
      post: compact({ id: p.postId, title: p.title, platform: p.platform, url: p.url, published: p.publishedAt, x: p.x, flag: p.flag ?? undefined, settled: p.settled, rank: d.rank, trialVariants: p.variants > 1 ? p.variants : undefined }),
      numbers: compact({ views: p.views, reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves, follows: p.follows, profileVisits: p.profileVisits, clicks: p.clicks, avgWatchS: p.avgWatchS, durationS: p.durationS, skipRate: p.skipRate, completionRate: p.completionRate, from: p.snapshot }),
      rates: compact(Object.fromEntries(Object.entries(p.rates).map(([k, v]) => [k, r3(v, 5)]))),
      velocity: p.velocity,
      hold3s: p.hold3s,
      usual: d.norms,
      series: d.series,
      usualCurve: d.usualCurve,
      retention: d.retention ? { curve: d.retention, usual: d.usualRetention } : "GAP: no retention curve for this post. Import one from a CSV export (retention column).",
      funnel: p.funnel,
      why: d.why,
      featureStats: d.featureLines,
      postMortems: d.postMortems.map((m) => ({ kind: m.kind, createdAt: m.createdAt, lessons: m.lessons, body: m.bodyMd.slice(0, 1200) })),
    });
  },
});

export const bestSlotsTool = defineTool({
  name: "learn_get_best_slots",
  description:
    "When to post: a day × time-of-day heatmap (local time) of how settled posts did vs the account's normal, with small slots pulled toward the normal so one lucky post can't crown a slot. " +
    "Returns the best slots (enough posts only), day and time-of-day summaries with sample sizes, and GAP lines for thin data.",
  input: z.object({
    metric: z.enum(["x", "send_rate", "follows_per_1k"]).default("x"),
    days: z.number().int().positive().max(365).default(90),
    platform: z.enum(PLATFORMS).optional(),
  }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const h = await bestSlots(ws, { metric: input.metric, days: input.days, platform: input.platform ?? null, includeScanned: true });
    const when = (c: { day: number; startHour: number; endHour: number }) => `${WEEKDAYS[c.day]} ${blockLabel(c.startHour, c.endHour)}`;
    return compact({
      metric: input.metric,
      timezone: h.timeZone,
      posts: h.n,
      overallMedian: h.overallMedian,
      best: h.best.map((c) => ({ when: when(c), n: c.n, median: c.medianX, adjusted: c.shrunkX, range: c.ciLow !== null ? [c.ciLow, c.ciHigh] : undefined, evidence: c.evidence })),
      byDay: h.byDay.map((d) => compact({ day: d.label, n: d.n, median: d.medianX, adjusted: d.shrunkX, evidence: d.evidence })),
      byTime: h.byBlock.map((b) => compact({ time: b.label, n: b.n, median: b.medianX, adjusted: b.shrunkX, evidence: b.evidence })),
      gaps: h.gaps.length ? h.gaps : undefined,
    });
  },
});

export const benchmarksTool = defineTool({
  name: "learn_get_benchmarks",
  description:
    "Your typical post against tracked creators', per platform: median views, engagement and outlier rate for you and each creator, your position, and their recent outliers (hook, format, x). Medians only.",
  input: z.object({ days: z.number().int().positive().max(365).default(90) }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const { posts } = await postFacts(ws, { includeScanned: true });
    const b = await competitorBenchmarks(ws, posts, { days: input.days });
    if (!b.length) return { empty: "GAP: no tracked-creator posts yet. Add creators to brand/competitors.yaml; the daily scan fills this in." };
    return b.map((x) => compact({
      platform: x.platform,
      you: x.own,
      creators: x.peers,
      peerMedianViews: x.peerMedianViews,
      yourViewsVsPeers: x.viewsRatio,
      yourEngagementVsPeers: x.engagementRatio,
      shareOfCreatorsBelowYou: x.viewsPercentile,
      peerOutlierShare: x.peerOutlierShare,
      recentOutliers: x.outliers.map((o) => compact({ handle: o.handle, x: o.x, views: o.views, hook: o.hook, format: o.format, url: o.url })),
      gaps: x.gaps.length ? x.gaps : undefined,
    }));
  },
});

export const goalPacingTool = defineTool({
  name: "learn_get_goal_pacing",
  description: "The north star and every active goal for this calendar week: target, actual so far, projected end of week, status (met / on track / at risk / behind) and what's needed per day.",
  input: z.object({}),
  annotations: { readOnly: true },
  async handler({ ws }) {
    return (await goalPacingReport(ws)).map((g) => compact({
      goal: g.label, metric: g.metric, northStar: g.isNorthStar, weekStart: g.weekStart, status: g.pace.status, target: g.pace.target, actual: g.pace.actual,
      projected: g.pace.projected, expectedByNow: g.pace.expectedByNow, neededPerDay: g.pace.requiredPerDay, line: g.pace.line,
      previousWeeks: g.history.map((h) => h.value), gap: g.gap,
    }));
  },
});

export const funnelTool = defineTool({
  name: "learn_get_funnel",
  description: "Post → link clicks → leads → booked calls → sales for posts published in the window, with conversion per step, the biggest drop, the posts that drove the most leads, and GAP lines for anything not connected.",
  input: z.object({ days: z.number().int().positive().max(365).default(30) }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const { posts } = await postFacts(ws);
    const f = await funnelReport(ws, posts, input.days);
    const byId = new Map(posts.map((p) => [p.postId, p]));
    return compact({
      days: input.days,
      steps: f.steps,
      biggestDrop: f.biggestDrop?.label,
      clicksFrom: f.clicksSource,
      per1kViews: f.per1k,
      topPosts: f.byPost.filter((r) => r.counts.leads || r.counts.bookings || r.counts.revenue).sort((a, b) => b.counts.revenue - a.counts.revenue || b.counts.bookings - a.counts.bookings || b.counts.leads - a.counts.leads).slice(0, 5)
        .map((r) => compact({ postId: r.postId, title: byId.get(r.postId)?.title, views: r.views, ...r.counts })),
      untagged: f.untagged,
      gaps: f.gaps.length ? f.gaps : undefined,
    });
  },
});

export const recordFunnelEventTool = defineTool({
  name: "learn_record_funnel_event",
  description: "Record a click, lead, booked call or sale the user reports (e.g. a call booked by phone), tagged with the post's utm_content so it is credited to that post.",
  input: z.object({ events: z.array(funnelEventInput).min(1).max(50) }),
  async handler({ ws }, input) {
    return recordFunnelEvents(ws, input.events, "agent");
  },
});

export const featureStatsTool = defineTool({
  name: "learn_get_feature_stats",
  description:
    "Which choices lift results: for each dimension value (lane, hook pattern, format, angle, funnel stage, CTA, length, posting slot, story structure) the median x, lift vs the account's typical post, n and a confidence range. " +
    "Lines starting with GAP mean there isn't enough data yet; say so instead of guessing. Also returns the picker weights the Strategist uses.",
  input: z.object({
    dimension: z.enum(FEATURE_DIMENSIONS).optional(),
    window: z.enum(["30d", "90d", "all", "competitor"]).default("90d"),
    /** Outcome to attribute: x vs your normal (default; what the weights use), send rate, or follows per 1k views. */
    metric: z.enum(["x", "send_rate", "follows_per_1k"]).default("x"),
    includeGaps: z.boolean().default(true),
  }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const window = input.window === "competitor" ? COMPETITOR_WINDOW : input.window;
    const stats = (await loadFeatureStats(ws, window, undefined, input.window === "competitor" ? "x" : input.metric)).filter((s) => !input.dimension || s.dimension === input.dimension);
    const weights = await getWeights(ws);
    return compact({
      window: input.window,
      computedAt: stats[0]?.computedAt,
      metric: input.metric,
      lines: stats.filter((s) => input.includeGaps || s.sufficient).map((s) => `${s.line}${s.sufficient ? ` [${s.verdict.replace("_", " ")}]` : ""}`),
      weights: input.dimension ? weights.weights[input.dimension] : weights.weights,
      weightSource: weights.source,
      ownShare: weights.ownShare,
      explore: weights.explore,
      empty: stats.length === 0 ? "No stats yet: they are computed daily once posts have settled numbers." : undefined,
    });
  },
});

export const listPostMortemsTool = defineTool({
  name: "learn_list_post_mortems",
  description: "Recent post-mortems (breakouts, flops, new bests) with their lessons. Read these before planning so wins get repeated and mistakes don't.",
  input: z.object({ kind: z.enum(["breakout", "flop", "new_best", "manual"]).optional(), limit: z.number().int().positive().max(20).default(5), full: z.boolean().default(false) }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const rows = await listPostMortems(ws, input);
    return rows.map((r) => compact({ ...r, bodyMd: input.full ? r.bodyMd : r.bodyMd.slice(0, 500) }));
  },
});

export const weeklyBriefingTool = defineTool({
  name: "learn_get_weekly_briefing",
  description: "The weekly report in one block: headline, north star and pacing, posts, typical post vs normal, rates, followers, best and weakest with why, what's lifting and holding back results, funnel, competitors, focus for next week, data gaps and spend. Computed fresh; nothing is sent.",
  input: z.object({}),
  annotations: { readOnly: true },
  async handler({ ws }) {
    const b = await buildWeeklyBriefing(ws);
    return compact({ ...b });
  },
});

export const postContextTool = defineTool({
  name: "learn_get_post_context",
  description: "Everything needed for a post-mortem of one own post: its numbers over time, x against the account's normal, the plan behind it (lane, angle, hook pattern, format), the script, and how its choices usually perform.",
  input: z.object({ postId: z.string().uuid() }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const ctx = await postContext(ws, input.postId);
    if (!ctx) throw new ToolError("No published post with that id", "Use learn_get_performance_summary to find post ids");
    return compact(ctx);
  },
});

export const savePostMortemTool = defineTool({
  name: "learn_save_post_mortem",
  description:
    'Save a post-mortem. bodyMd must have the sections "## What happened", "## Why we think it happened", "## What to repeat", "## What to change". ' +
    "lessons are 1–3 short rules in plain language (they're proposed for brand/lessons.md, not written there automatically).",
  input: z.object({
    postId: z.string().uuid(),
    kind: z.enum(["breakout", "flop", "new_best", "manual"]),
    bodyMd: postMortemBodySchema,
    lessons: z.array(z.string().min(5).max(240)).min(1).max(3),
  }),
  async handler({ ws }, input) {
    const problems = checkPostMortemBody(input.bodyMd);
    if (problems.length) throw new ToolError(`Post-mortem not saved: ${problems.join("; ")}`);
    const [exists] = await ws.sql`select 1 from posts where workspace_id = ${ws.id} and id = ${input.postId}`;
    if (!exists) throw new ToolError("No post with that id");
    const r = await savePostMortem(ws, input);
    return { saved: true, id: r.id, x: r.x === null ? null : round(r.x, 2) };
  },
});

export const LEARN_TOOLS = [
  performanceSummaryTool, postDetailTool, featureStatsTool, bestSlotsTool, benchmarksTool, goalPacingTool, funnelTool,
  listPostMortemsTool, weeklyBriefingTool, postContextTool, savePostMortemTool, recordFunnelEventTool,
];

import { localDay, median, round } from "@attentionos/scoring";
import { loadFeatureStats, type StoredFeatureStat } from "../attribution.ts";
import { northStar, type GoalPacing, type NorthStarReading } from "../northStar.ts";
import { competitorBenchmarks, type PlatformBenchmark } from "./benchmarks.ts";
import { DAY_MS, type AnalyticsCtx } from "./ctx.ts";
import { funnelReport, type FunnelReport } from "./funnel.ts";
import { overview, type BestPost, type Kpi } from "./overview.ts";
import { bestSlotsFrom, type BestSlots } from "./slots.ts";
import { blockLabel, WEEKDAYS } from "@attentionos/scoring";

/**
 * The weekly report (weekly briefing): every section computed in code from the same functions Insights
 * and the MCP tools use, GAP lines kept as GAP lines, and a deterministic "focus next week" list tied to the numbers.
 */

export type WeeklyReport = {
  weekEnding: string;
  headline: string;
  northStar: NorthStarReading;
  pacing: GoalPacing | null;
  kpis: Kpi[];
  posts: number;
  previousPosts: number;
  medianX: number | null;
  previousMedianX: number | null;
  followers: { current: number | null; delta7: number | null; previous7: number | null };
  best: BestPost | null;
  worst: BestPost | null;
  wins: StoredFeatureStat[];
  losses: StoredFeatureStat[];
  slots: BestSlots;
  benchmark: PlatformBenchmark | null;
  funnel: FunnelReport;
  focus: string[];
  gaps: string[];
  spend: { llm: number; scraping: number; images: number; publishing: number };
  postMortems: number;
  markdown: string;
};

const fx = (x: number | null) => (x === null ? "n/a" : `${round(x, x < 1 ? 2 : 1)}×`);
const pct = (v: number | null, d = 1) => (v === null ? "n/a" : `${(v * 100).toFixed(d)}%`);
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US")}`;
const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
const fmtValue = (unit: GoalPacing["unit"], v: number | null) => (v === null ? "n/a" : unit === "usd" ? usd(v) : unit === "rate" ? pct(v) : String(round(v, 2)));

const DIM: Record<string, string> = {
  hook_pattern: "hook", lane: "lane", format: "format", angle: "angle", funnel_stage: "funnel stage", cta_type: "CTA", length_bucket: "length", slot: "posting time", story_structure: "structure",
};
const featureName = (s: { dimension: string; value: string }) => `${DIM[s.dimension] ?? s.dimension.replace(/_/g, " ")} "${s.value.replace(/_/g, " ")}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

async function spendSince(ctx: AnalyticsCtx, since: Date) {
  const rows = await ctx.sql`
    select category, coalesce(sum(amount_micro), 0)::text as micro from cost_ledger
     where workspace_id = ${ctx.id} and ts >= ${since} group by category`;
  const get = (c: string) => Math.round((Number(rows.find((r) => r.category === c)?.micro ?? 0) / 1e6) * 100) / 100;
  return { llm: get("llm"), scraping: get("scraping"), images: get("images"), publishing: get("publishing") };
}

export async function weeklyReport(ctx: AnalyticsCtx): Promise<WeeklyReport> {
  const now = ctx.now();
  const tz = ctx.config.workspace.timezone;
  const ov = await overview(ctx, { days: 7, weeks: 8 });
  const all = ov.facts.posts;
  const t = now.getTime();
  const thisWeek = all.filter((p) => Date.parse(p.publishedAt) >= t - 7 * DAY_MS);
  const lastWeek = all.filter((p) => Date.parse(p.publishedAt) >= t - 14 * DAY_MS && Date.parse(p.publishedAt) < t - 7 * DAY_MS);
  const medianX = median(thisWeek.map((p) => p.x));
  const previousMedianX = median(lastWeek.map((p) => p.x));
  const ns = await northStar(ctx, now);
  const pacing = ov.pacing.find((p) => p.isNorthStar) ?? null;
  const stats = (await loadFeatureStats(ctx, "90d")).filter((s) => s.dimension !== "slot");
  const wins = stats.filter((s) => s.verdict === "clear_win" || s.verdict === "leaning_up").sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0)).slice(0, 3);
  const losses = stats.filter((s) => s.verdict === "clear_loss" || s.verdict === "leaning_down").sort((a, b) => (a.lift ?? 9) - (b.lift ?? 9)).slice(0, 2);
  const slots = bestSlotsFrom(ctx, all.filter((p) => Date.parse(p.publishedAt) >= t - 90 * DAY_MS), { days: 90 });
  const benches = await competitorBenchmarks(ctx, all);
  const benchmark = benches[0] ?? null;
  const funnel = await funnelReport(ctx, all, 7);
  const spend = await spendSince(ctx, new Date(t - 7 * DAY_MS));
  const [pm] = await ctx.sql`select count(*)::int as n from post_mortems where workspace_id = ${ctx.id} and created_at >= ${new Date(t - 7 * DAY_MS)}`;
  const postMortems = Number(pm?.n ?? 0);

  const gaps = [
    ...(ns.gap ? [ns.gap] : []),
    ...stats.filter((s) => !s.sufficient).slice(0, 3).map((s) => s.line),
    ...slots.gaps.slice(0, 1),
    ...(benchmark?.gaps.slice(0, 1) ?? []),
    ...funnel.gaps.slice(0, 2),
    ...(ov.followers.gap ? [ov.followers.gap] : []),
  ];

  // Focus next week: each item is an action tied to a number above.
  const focus: string[] = [];
  const clearWin = wins.find((s) => s.verdict === "clear_win");
  if (clearWin) focus.push(`Make more ${featureName(clearWin)} posts: median ${fx(clearWin.medianX)} over ${clearWin.n} posts, clearly above your usual.`);
  else if (wins[0]) focus.push(`Test more ${featureName(wins[0])} posts: median ${fx(wins[0].medianX)} over ${wins[0].n} posts, but the range still crosses your usual.`);
  const clearLoss = losses.find((s) => s.verdict === "clear_loss") ?? losses[0];
  if (clearLoss) focus.push(`Rework or pause ${featureName(clearLoss)}: ${fx(clearLoss.medianX)} over ${clearLoss.n} posts.`);
  const slot = slots.best[0];
  if (slot && focus.length < 3) focus.push(`Schedule the next strong idea for ${WEEKDAYS[slot.day]} ${blockLabel(slot.startHour, slot.endHour)} (${fx(slot.shrunkX)} over ${slot.n} posts).`);
  if (pacing && (pacing.pace.status === "behind" || pacing.pace.status === "at_risk") && pacing.pace.requiredPerDay !== null && focus.length < 3) {
    focus.push(`${pacing.label} needs ${fmtValue(pacing.unit, pacing.pace.requiredPerDay)} a day for the rest of the week to hit ${fmtValue(pacing.unit, pacing.pace.target)}.`);
  }
  if (ov.best && focus.length < 3 && ov.best.post.flag === "breakout") focus.push(`Follow up on "${ov.best.post.title ?? "the best post"}" (${fx(ov.best.post.x)}) while the topic is warm.`);

  const nsLine = ns.value === null
    ? `${ns.label}: not measured. ${ns.gap ?? ""}`.trim()
    : `${ns.label}: ${ns.metric === "skip_rate" ? pct(ns.value) : ns.value}${ns.previous !== null ? ` (last week ${ns.metric === "skip_rate" ? pct(ns.previous) : ns.previous})` : ""}${ns.target !== null ? `, target ${ns.target}` : ""}`;
  const bestBit = ov.best ? `; the best post ran ${fx(ov.best.post.x)} your usual` : "";
  const headline = pacing?.pace.status === "met" && pacing.pace.target !== null
    ? `${ns.label.replace(/ per week$/, "")} hit this week's goal, ${fmtValue(pacing.unit, pacing.pace.actual)} of ${fmtValue(pacing.unit, pacing.pace.target)}${bestBit}.`
    : ns.value !== null && ns.previous !== null && ns.value !== ns.previous
    ? `${ns.label} ${(ns.metric === "skip_rate" ? ns.value < ns.previous : ns.value > ns.previous) ? "improved" : "slipped"} to ${ns.metric === "skip_rate" ? pct(ns.value) : ns.value}${ov.best ? `; best post ran ${fx(ov.best.post.x)} your usual` : ""}.`
    : ov.best
      ? `Best post this ${ov.best.period} ran ${fx(ov.best.post.x)} your usual.`
      : thisWeek.length
        ? `${thisWeek.length} post${thisWeek.length === 1 ? "" : "s"} went out; numbers are still settling.`
        : "No posts went out this week.";

  const kpi = (k: string) => ov.kpis.find((x) => x.key === k);
  const lines = [
    `*Week ending ${localDay(now, tz)}*`,
    "",
    headline,
    "",
    nsLine,
    ...(pacing ? [`Pace: ${pacing.pace.line}`] : []),
    `Posts published: ${thisWeek.length} (last week ${lastWeek.length})`,
    `Typical post: ${fx(medianX)} your normal (last week ${fx(previousMedianX)})`,
    ...(kpi("send_rate")?.value != null ? [`Send rate: ${pct(kpi("send_rate")!.value, 2)} · engagement ${pct(kpi("engagement")?.value ?? null)} · follows per 1k views ${kpi("follows_per_1k")?.value?.toFixed(1) ?? "n/a"}`] : []),
    ...(ov.followers.delta7 !== null ? [`Followers: ${ov.followers.current?.toLocaleString("en-US")} (${signed(ov.followers.delta7)} this week${ov.followers.previous7 !== null ? `, ${signed(ov.followers.previous7)} the week before` : ""})`] : []),
    ...(ov.best ? ["", `Best: ${ov.best.post.title ?? ov.best.post.url ?? "a post"} at ${fx(ov.best.post.x)}`, ...ov.best.why.map((w) => `- ${w}`)] : []),
    ...(ov.worst ? [`Weakest: ${ov.worst.post.title ?? ov.worst.post.url ?? "a post"} at ${fx(ov.worst.post.x)}`, ...ov.worst.why.slice(0, 2).map((w) => `- ${w}`)] : []),
    ...(wins.length ? ["", "What's lifting results:", ...wins.map((s) => `- ${s.line}`)] : []),
    ...(losses.length ? ["What's holding results back:", ...losses.map((s) => `- ${s.line}`)] : []),
    ...(funnel.totals.leads || funnel.totals.bookings ? ["", `Funnel: ${plural(funnel.totals.views, "view")} → ${funnel.clicksSource === "none" ? "clicks n/a" : plural(funnel.totals.clicks, "click")} → ${plural(funnel.totals.leads, "lead")} → ${plural(funnel.totals.bookings, "booked call")}${funnel.totals.revenue ? ` → ${usd(funnel.totals.revenue)}` : ""}`] : []),
    ...(benchmark && benchmark.viewsRatio !== null ? [`Against tracked creators: your typical post gets ${fx(benchmark.viewsRatio)} their median views`] : []),
    ...(focus.length ? ["", "Focus next week:", ...focus.map((f) => `- ${f}`)] : []),
    ...(gaps.length ? ["", "Not enough data yet:", ...gaps.slice(0, 6).map((g) => `- ${g}`)] : []),
    "",
    `Spend this week: LLM ${usd(spend.llm)}, scraping ${usd(spend.scraping)}, images ${usd(spend.images)}`,
    ...(postMortems ? [`Post-mortems written: ${postMortems}`] : []),
  ];

  return {
    weekEnding: localDay(now, tz), headline, northStar: ns, pacing, kpis: ov.kpis, posts: thisWeek.length, previousPosts: lastWeek.length,
    medianX, previousMedianX, followers: { current: ov.followers.current, delta7: ov.followers.delta7, previous7: ov.followers.previous7 },
    best: ov.best, worst: ov.worst, wins, losses, slots, benchmark, funnel, focus, gaps, spend, postMortems, markdown: lines.join("\n"),
  };
}

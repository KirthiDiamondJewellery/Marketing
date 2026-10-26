import { z } from "zod";
import { defineLlmJob, defineNativeJob, type WorkspaceContext } from "@attentionos/core";
import { enqueueRun, fmtUsd, periodStart, queueNotification, spendSince } from "@attentionos/module-research";
import { localDay, round } from "@attentionos/scoring";
import { weeklyReport, type WeeklyReport } from "./analytics/report.ts";
import type { NorthStarReading } from "./northStar.ts";
import { learnSettings } from "./settings.ts";

/** Weekly briefing: native numbers first (the weekly report Insights shows); optional LLM prose on top. */

export type WeeklyBriefing = {
  weekEnding: string;
  headline: string;
  posts: number;
  medianX: number | null;
  previousMedianX: number | null;
  best: { title: string | null; url: string | null; x: number; why: string[] } | null;
  worst: { title: string | null; url: string | null; x: number; why: string[] } | null;
  northStar: NorthStarReading;
  pace: string | null;
  topLifts: string[];
  holdingBack: string[];
  focus: string[];
  gaps: string[];
  spend: { llm: number; scraping: number; images: number; publishing: number };
  postMortems: number;
  markdown: string;
};

const fmtX = (x: number | null) => (x === null ? "n/a" : `${round(x, 2)}x`);

export async function buildWeeklyBriefing(ws: WorkspaceContext): Promise<WeeklyBriefing> {
  const r = await weeklyReport(ws);
  const brief = (b: WeeklyReport["best"]) => (b && b.post.x !== null ? { title: b.post.title, url: b.post.url, x: b.post.x, why: b.why } : null);
  return {
    weekEnding: r.weekEnding,
    headline: r.headline,
    posts: r.posts,
    medianX: r.medianX,
    previousMedianX: r.previousMedianX,
    best: brief(r.best),
    worst: brief(r.worst),
    northStar: r.northStar,
    pace: r.pacing?.pace.line ?? null,
    topLifts: r.wins.map((s) => s.line),
    holdingBack: r.losses.map((s) => s.line),
    focus: r.focus,
    gaps: r.gaps,
    spend: r.spend,
    postMortems: r.postMortems,
    markdown: r.markdown,
  };
}

export const weeklyBriefingJob = defineNativeJob({
  kind: "native",
  id: "learn.weekly-briefing",
  agent: "analyst",
  description: "Sends the weekly numbers: north star, typical post against your normal, best and weakest, what's lifting results, gaps and spend.",
  input: z.object({}),
  async run(ctx) {
    const b = await buildWeeklyBriefing(ctx.ws);
    await queueNotification(ctx.ws, { text: b.markdown, format: "markdown", dedupeKey: `weekly-briefing:${b.weekEnding}` });
    if (learnSettings(ctx.ws).weeklyBriefing.prose) {
      await enqueueRun(ctx.ws, { jobId: "learn.weekly-briefing-prose", agent: "analyst", input: { weekEnding: b.weekEnding }, dedupeKey: `weekly-prose:${b.weekEnding}`, parentRunId: ctx.runId, createdBy: "agent:analyst" });
    }
    await ctx.progress(`Sent the weekly briefing: ${b.posts} post${b.posts === 1 ? "" : "s"}, typical post ${fmtX(b.medianX)} your normal`);
    return { weekEnding: b.weekEnding, posts: b.posts, medianX: b.medianX };
  },
});

export const briefingProseOutputSchema = z.object({
  summary: z.string().min(40).max(1200),
  focusNextWeek: z.array(z.string().max(200)).min(1).max(3),
}).strict();

export const weeklyBriefingProseJob = defineLlmJob({
  kind: "llm",
  id: "learn.weekly-briefing-prose",
  agent: "analyst",
  description: "Writes a short plain-language read of the weekly numbers with up to three things to focus on.",
  input: z.object({ weekEnding: z.string() }),
  skill: "weekly-briefing",
  toolless: true,
  allowedTools: [],
  defaultModel: "sonnet",
  // The structured answer takes its own step on the Claude Code engine, so one turn always fails.
  maxTurns: 3,
  budgetUsd: 0.1,
  output: briefingProseOutputSchema,
  async prompt(ctx) {
    const b = await buildWeeklyBriefing(ctx.ws);
    return [
      "Here are this week's numbers for the account (all computed by code; don't invent others):",
      b.markdown,
      "",
      "Write a summary of at most 120 words in plain language and up to three concrete things to focus on next week.",
      "Name GAP lines honestly as missing data, not as findings.",
      'Reply with JSON only: {"summary": "...", "focusNextWeek": ["..."]}',
    ].join("\n");
  },
  async onOutput(ctx, output) {
    const parsed = briefingProseOutputSchema.parse(output);
    const text = [parsed.summary, "", "Focus next week:", ...parsed.focusNextWeek.map((f) => `- ${f}`)].join("\n");
    await queueNotification(ctx.ws, { text, dedupeKey: `weekly-prose:${ctx.input.weekEnding}` });
  },
});


/** Cost watch: spend vs budgets, alerting at the warn share and again when over. */
export type CostLine = { category: "llm" | "scraping" | "images"; period: "day" | "month"; spent: number; budget: number; share: number; level: "ok" | "warn" | "over" };

export async function costWatch(ws: WorkspaceContext): Promise<CostLine[]> {
  const now = ws.now();
  const tz = ws.config.workspace.timezone;
  const warnAt = learnSettings(ws).costWatch.warnAt;
  const b = ws.config.budgets;
  const checks: Omit<CostLine, "spent" | "share" | "level">[] = [
    { category: "llm", period: "day", budget: b.dailyUsd },
    { category: "scraping", period: "month", budget: b.scrapingMonthlyUsd },
    { category: "images", period: "day", budget: b.imagesDailyUsd },
  ];
  const out: CostLine[] = [];
  for (const c of checks) {
    const start = periodStart(now, tz, c.period);
    const spent = await spendSince(ws, c.category, start);
    const share = c.budget > 0 ? spent / c.budget : spent > 0 ? Infinity : 0;
    const level = share >= 1 ? "over" : share >= warnAt ? "warn" : "ok";
    out.push({ ...c, spent, share, level });
    if (level === "ok") continue;
    const what = c.category === "llm" ? "AI spend" : c.category === "scraping" ? "Scraping spend" : "Image spend";
    const when = c.period === "day" ? "today" : "this month";
    const text = level === "over"
      ? `${what} ${when} is ${fmtUsd(spent)}, over your ${fmtUsd(c.budget)} budget. Jobs that spend on this will pause until the budget resets or you raise it.`
      : `${what} ${when} is ${fmtUsd(spent)}, ${Math.round(share * 100)}% of your ${fmtUsd(c.budget)} budget.`;
    const periodKey = c.period === "day" ? localDay(now, tz) : localDay(now, tz).slice(0, 7);
    await queueNotification(ws, { text, priority: level === "over" ? "high" : "normal", dedupeKey: `cost:${c.category}:${periodKey}:${level}` });
  }
  return out;
}

export const costWatchJob = defineNativeJob({
  kind: "native",
  id: "learn.cost-watch",
  agent: "analyst",
  description: "Compares AI, scraping and image spend with your budgets and warns before they run out.",
  input: z.object({}),
  async run(ctx) {
    const lines = await costWatch(ctx.ws);
    const flagged = lines.filter((l) => l.level !== "ok");
    if (flagged.length) await ctx.progress(`Spend check: ${flagged.map((l) => `${l.category} at ${Math.round(l.share * 100)}% of budget`).join(", ")}`);
    return { lines: lines.map((l) => ({ ...l, share: Number.isFinite(l.share) ? round(l.share, 3) : null })) };
  },
});

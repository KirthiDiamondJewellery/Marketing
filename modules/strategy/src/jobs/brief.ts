import { z } from "zod";
import { defineLlmJob, defineNativeJob, type WorkspaceContext } from "@attentionos/core";
import { getWeights } from "@attentionos/module-learn";
import { enqueueRun, queueNotification } from "@attentionos/module-research";
import { loadPresetDefaults, parsePillars, type IdeaKind } from "../pillars.ts";
import { DEFAULT_TEMPLATES, planSlate, type PlannerInput, type PlanResult } from "../planner.ts";
import { nicheWordsFrom, rankRemixSources, remixSlots, type RankedRemix } from "../remix.ts";
import {
  briefFor, createBriefApproval, insertSlate, laneCountsSince, proofCandidates, recentPieces, remixPool, todayLocal, trendCandidates, weekStart,
  type BriefRow,
} from "../repo.ts";
import { cancelQueuedScripts, queueScriptsForBrief, type ScriptHandoff } from "../script-handoff.ts";
import { strategySettings } from "../settings.ts";

export type BriefMode = "daily" | "batch";

/** Collects everything the planner needs from the Brand Kit, the database and learn's weights. */
export async function buildPlannerInput(ws: WorkspaceContext, mode: BriefMode, date: string): Promise<{ input: PlannerInput; formats: ReturnType<typeof loadPresetDefaults>["formats"]; problems: string[] }> {
  const s = strategySettings(ws);
  const kit = ws.brand();
  const pillars = parsePillars(kit.docs["pillars"]);
  const preset = loadPresetDefaults(ws.paths.brand, kit.docs);
  const now = ws.now();
  const recent = await recentPieces(ws);
  const weights = await getWeights(ws);

  // Remix-first: about `remixShare` of the slate remakes proven posts; the lanes keep their offer and news slots.
  let slots: Record<IdeaKind, number> = remixSlots(s.daily, s.remixShare);
  if (mode === "batch") {
    const size = s.batchSize ?? preset.weeklyShortVideos ?? Math.max(1, pillars.lanes.reduce((n, l) => n + l.weeklyQuota, 0));
    const offer = Math.min(size, Math.max(1, pillars.lanes.filter((l) => l.kinds.includes("offer")).reduce((n, l) => n + l.weeklyQuota, 0)));
    const remix = Math.round((size - offer) * s.remixShare);
    // News is filmed the day it breaks, so the batch edition leaves it to the daily brief.
    slots = { news: 0, remix, talking_head: size - offer - remix, offer };
  }
  const remixes = rankRemixSources(await remixPool(ws, s.remixSources), {
    now,
    nicheWords: nicheWordsFrom(pillars.lanes, [kit.docs["pillars"], kit.docs["icp"], kit.docs["offers"], ...kit.brand.offers.map((o) => o.name)]),
    ...s.remixSources,
  });

  const templates = { ...pillars.templates };
  const known = Object.keys(preset.formats);
  if (known.length) {
    // Only rotate through formats this workspace has (from the preset's format list).
    for (const kind of ["news", "remix", "talking_head", "offer"] as IdeaKind[]) {
      if (templates[kind]?.length) continue;
      const defaults = DEFAULT_TEMPLATES[kind].filter((t) => known.includes(t));
      if (defaults.length) templates[kind] = defaults;
    }
  }

  const input: PlannerInput = {
    mode,
    now,
    seed: `${ws.id}:${date}:${mode}`,
    slots,
    lanes: pillars.lanes,
    laneCountsThisWeek: mode === "batch" ? {} : await laneCountsSince(ws, weekStart(now, ws.config.workspace.timezone)),
    funnelTarget: kit.brand.funnelMix,
    recentFunnel: recent.map((r) => r.funnelStage).filter((f): f is NonNullable<typeof f> => !!f).slice(0, s.funnelWindow),
    mainAngle: pillars.mainAngle,
    angles: pillars.angles,
    storyStructures: pillars.storyStructures,
    recent,
    rejected: pillars.rejected.map((r) => r.text),
    trends: mode === "batch" ? [] : await trendCandidates(ws),
    outliers: remixes.map(toOutlier),
    proof: await proofCandidates(ws),
    offers: kit.brand.offers.map((o) => ({ id: o.id, name: o.name, cta: o.cta })),
    templates,
    ctaByStage: preset.ctaByStage,
    weights: weights.weights,
    explore: weights.explore,
    cooldowns: {
      topicDays: pillars.cooldowns.topicDays ?? s.cooldowns.topicDays,
      proofDays: pillars.cooldowns.proofDays ?? s.cooldowns.proofDays,
      angleDays: pillars.cooldowns.angleDays ?? s.cooldowns.angleDays,
    },
    filmBy: mode === "batch" ? { newsHours: s.filmBy.newsHours, defaultHours: 24 } : s.filmBy,
    storyShare: s.storyShare,
  };
  return {
    input,
    formats: preset.formats,
    problems: [...pillars.problems, ...(pillars.fallbackLanes ? ["brand/pillars.md has no lanes yet, so generic reach / trust / offer lanes were used"] : [])],
  };
}

function toOutlier(r: RankedRemix): PlannerInput["outliers"][number] {
  return { id: r.id, url: r.url, creator: r.creator, platform: r.platform, x: r.x, views: r.views, own: r.own, topic: r.topic, hookPattern: r.hookPattern, format: r.format, score: r.score };
}

export type BriefResult = { date: string; mode: BriefMode; created: boolean; items: BriefRow[]; notes: string[]; approvalRef?: string; scripts?: ScriptHandoff };

const KIND_LABEL: Record<string, [string, string]> = {
  news: ["news reel", "news reels"],
  remix: ["outlier remix", "outlier remixes"],
  talking_head: ["talking head", "talking heads"],
  offer: ["offer piece", "offer pieces"],
};

export function summarise(items: { brief: Record<string, unknown> }[], mode: BriefMode): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(String(i.brief.kind), (counts.get(String(i.brief.kind)) ?? 0) + 1);
  const parts = [...counts.entries()].map(([k, n]) => `${n} ${KIND_LABEL[k]?.[n === 1 ? 0 : 1] ?? k}`);
  return `${mode === "batch" ? "Batch day" : "Film today"}: ${items.length} piece${items.length === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/**
 * The "Film today" brief: plans the slate deterministically, writes `content` rows (status idea),
 * opens one approval, queues one notification, and hands the slate to an LLM run that drafts headers and
 * shoot directions. Idempotent per date and mode unless `replan` is set.
 */
export async function runBrief(ws: WorkspaceContext, opts: { mode: BriefMode; date?: string; replan?: boolean; runId?: string | null }): Promise<BriefResult> {
  const date = opts.date ?? todayLocal(ws);
  const existing = await briefFor(ws, date, opts.mode);
  if (existing.length && !opts.replan) return { date, mode: opts.mode, created: false, items: existing, notes: [] };
  if (existing.length && opts.replan) {
    await ws.sql`update content set status = 'archived', updated_at = ${ws.now()} where workspace_id = ${ws.id} and status = 'idea' and id = any(${existing.map((e) => e.id)}::uuid[])`;
    await cancelQueuedScripts(ws, existing.filter((e) => e.status === "idea").map((e) => e.id));
  }

  const { input, formats, problems } = await buildPlannerInput(ws, opts.mode, date);
  const plan: PlanResult = planSlate(input);
  const items = await insertSlate(ws, plan.items, { date, mode: opts.mode, formats });
  const notes = [...problems, ...plan.notes];
  if (items.length === 0) return { date, mode: opts.mode, created: false, items, notes };

  const summary = summarise(items, opts.mode);
  const tz = ws.config.workspace.timezone;
  const lines = items.map((i) => `${i.brief.slot}. ${i.title} · ${String(i.brief.laneName ?? i.lane)}${i.filmBy ? ` · film by ${new Date(i.filmBy).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}`);
  const approvalRef = await createBriefApproval(ws, summary, { date, mode: opts.mode, items: items.map((i) => ({ id: i.id, title: i.title, kind: i.brief.kind, lane: i.lane, filmBy: i.filmBy })) }, opts.runId);
  await enqueueRun(ws, { jobId: "strategy.draft-brief", agent: "strategist", input: { date, mode: opts.mode }, dedupeKey: `draft-brief:${opts.mode}:${date}`, parentRunId: opts.runId ?? null, createdBy: "agent:strategist" });

  // Hand the filmable ideas to the Copywriter (each script still waits for the owner's OK).
  const s = strategySettings(ws);
  let scripts: ScriptHandoff | undefined;
  if (s.scriptHandoffJobId) {
    await enqueueRun(ws, { jobId: s.scriptHandoffJobId, agent: "copywriter", input: { contentIds: items.map((i) => i.id) }, dedupeKey: `scripts:${opts.mode}:${date}`, parentRunId: opts.runId ?? null, createdBy: "agent:strategist", runAfter: new Date(ws.now().getTime() + 10 * 60_000) });
  } else {
    scripts = await queueScriptsForBrief(ws, items, { date, mode: opts.mode, runId: opts.runId ?? null });
  }
  const n = scripts?.queued.length ?? 0;
  const handoffLine = s.scriptHandoffJobId
    ? `Reply ok ${approvalRef} to send these to the Copywriter, or tell me what to swap.`
    : n
      ? `The Copywriter starts on ${n === items.length ? (n === 1 ? "the script" : `all ${n} scripts`) : `${n} script${n === 1 ? "" : "s"} (soonest first)`} shortly; each one comes back for your OK. Reply ok ${approvalRef} to keep this plan, or tell me what to swap.`
      : `Reply ok ${approvalRef} to keep this plan, or tell me what to swap. Ask for scripts from the Film page when you're ready.`;
  await queueNotification(ws, {
    text: [summary, "", ...lines, ...(notes.length ? ["", ...notes] : []), "", handoffLine].join("\n"),
    dedupeKey: `brief:${opts.mode}:${date}${opts.replan ? `:${ws.now().getTime()}` : ""}`,
    ref: approvalRef,
    actions: [{ id: `approve:${approvalRef}`, label: "Looks good", style: "primary" }, { id: `revise:${approvalRef}`, label: "Swap something" }],
  });
  return { date, mode: opts.mode, created: true, items, notes, approvalRef, ...(scripts ? { scripts } : {}) };
}

function scriptsLine(r: BriefResult): string {
  const n = r.scripts?.queued.length ?? 0;
  return n ? `; asked the Copywriter for ${n} script${n === 1 ? "" : "s"}` : "";
}

const briefInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), replan: z.boolean().default(false) });

export const dailyBriefJob = defineNativeJob({
  kind: "native",
  id: "strategy.daily-brief",
  agent: "strategist",
  description: 'Plans today\'s "Film today" slate, led by remixes of proven posts (competitor outliers and your own breakouts), plus fresh news and the offer piece, each with a lane, format and deadline.',
  input: briefInput,
  async run(ctx) {
    const r = await runBrief(ctx.ws, { mode: "daily", ...(ctx.input.date ? { date: ctx.input.date } : {}), replan: ctx.input.replan, runId: ctx.runId });
    await ctx.progress(r.created ? `${summarise(r.items, "daily")}. Drafting headers and shoot directions next${scriptsLine(r)}.` : r.items.length ? "Today's brief already exists" : `Nothing to plan: ${r.notes.join("; ")}`);
    return { date: r.date, created: r.created, items: r.items.length, approval: r.approvalRef ?? null, notes: r.notes, scriptsQueued: r.scripts?.queued.length ?? 0 };
  },
});

export const batchDayJob = defineNativeJob({
  kind: "native",
  id: "strategy.batch-day",
  agent: "strategist",
  description: "Plans a week of videos to film in one session, balanced across lanes and the funnel mix.",
  input: briefInput,
  async run(ctx) {
    const r = await runBrief(ctx.ws, { mode: "batch", ...(ctx.input.date ? { date: ctx.input.date } : {}), replan: ctx.input.replan, runId: ctx.runId });
    await ctx.progress(r.created ? `${summarise(r.items, "batch")}. Drafting headers and shoot directions next${scriptsLine(r)}.` : "This batch day is already planned");
    return { date: r.date, created: r.created, items: r.items.length, approval: r.approvalRef ?? null, notes: r.notes, scriptsQueued: r.scripts?.queued.length ?? 0 };
  },
});

export const draftBriefJob = defineLlmJob({
  kind: "llm",
  id: "strategy.draft-brief",
  agent: "strategist",
  description: "Drafts an on-screen header and shoot directions for every piece in the brief.",
  input: z.object({ date: z.string(), mode: z.enum(["daily", "batch"]) }),
  skill: "daily-brief",
  allowedTools: [
    "mcp__attentionos__strategy_get_todays_brief",
    "mcp__attentionos__strategy_save_brief_item",
    "mcp__attentionos__learn_list_post_mortems",
    "mcp__attentionos__knowledge_search",
    "Read",
  ],
  defaultModel: "sonnet",
  maxTurns: 20,
  budgetUsd: 0.5,
  prompt: (ctx) =>
    [
      `Draft the ${ctx.input.mode === "batch" ? "batch-day" : "Film today"} brief for ${ctx.input.date}.`,
      `1. Call strategy_get_todays_brief with date ${ctx.input.date} and mode ${ctx.input.mode}.`,
      "2. Read brand/voice.md, brand/icp.md and brand/pillars.md; skim learn_list_post_mortems for what to repeat or avoid.",
      "3. For every item call strategy_save_brief_item with a header (on-screen, max 60 characters), a one-line hook idea and 2–4 shoot directions.",
      "Numbers may only come from the item's proof numbers. Don't write scripts; the Copywriter does that next.",
    ].join("\n"),
});

import { z } from "zod";
import { jsonb, defineLlmJob, defineNativeJob, type WorkspaceContext } from "@attentionos/core";
import { enqueueRun, iso, num } from "@attentionos/module-research";
import { postFacts } from "./analytics/posts.ts";
import { classifyForPostMortem } from "@attentionos/scoring";
import { computeOwnScores } from "./metrics.ts";
import { learnSettings } from "./settings.ts";
import { postDetail } from "./analytics/detail.ts";

/**
 * Post-mortems: drafted for every breakout (>= 2x), flop (< 0.6x) and new best, with wins and
 * losses given the same depth. A native scan finds them once their numbers have settled; an LLM job writes
 * the draft through `learn_get_post_context` and `learn_save_post_mortem`.
 */

export const POST_MORTEM_SECTIONS = ["What happened", "Why we think it happened", "What to repeat", "What to change"] as const;

export type PostMortemCandidate = { postId: string; kind: "breakout" | "flop" | "new_best"; x: number };

export async function findPostMortemCandidates(ws: WorkspaceContext): Promise<PostMortemCandidate[]> {
  const s = learnSettings(ws).postMortem;
  const { posts } = await postFacts(ws, { persist: true });
  const done = new Set((await ws.sql`select post_id from post_mortems where workspace_id = ${ws.id} and post_id is not null`).map((r) => r.post_id as string));
  const settledLabels = s.afterSnapshot === "7d" ? new Set(["7d", "30d"]) : new Set(["72h", "7d", "30d"]);
  const out: PostMortemCandidate[] = [];
  let best: number | null = null;
  for (const p of posts) {
    // Posts are in publish order, so `best` is the best x of everything published before this one.
    const ready = p.x !== null && (settledLabels.has(p.snapshot ?? "") || (p.settled && ws.now().getTime() - new Date(p.publishedAt).getTime() >= (s.afterSnapshot === "7d" ? 168 : 72) * 3_600_000));
    if (ready && !done.has(p.postId)) {
      // A hook that loses most viewers in the first seconds is a flop whatever the views did.
      const kind = classifyForPostMortem(p.x, best, { breakoutX: s.breakoutX, flopX: s.flopX }) ?? (p.hold3s !== null && p.hold3s < 1 - s.flopSkipRate ? "flop" : null);
      if (kind) out.push({ postId: p.postId, kind, x: p.x! });
    }
    if (p.x !== null && p.settled) best = best === null ? p.x : Math.max(best, p.x);
  }
  return out;
}

export async function scanPostMortems(ws: WorkspaceContext, runId?: string | null): Promise<{ queued: number; candidates: PostMortemCandidate[] }> {
  const candidates = await findPostMortemCandidates(ws);
  let queued = 0;
  for (const c of candidates) {
    const id = await enqueueRun(ws, { jobId: "learn.post-mortem", agent: "analyst", input: { postId: c.postId, kind: c.kind }, dedupeKey: `post-mortem:${c.postId}`, parentRunId: runId ?? null, createdBy: "agent:analyst" });
    if (id) queued++;
  }
  return { queued, candidates };
}

export const postMortemScanJob = defineNativeJob({
  kind: "native",
  id: "learn.post-mortem-scan",
  agent: "analyst",
  description: "Finds breakouts, flops and new bests whose numbers have settled and queues a post-mortem for each.",
  input: z.object({}),
  async run(ctx) {
    const r = await scanPostMortems(ctx.ws, ctx.runId);
    if (r.queued) {
      const n = (k: string) => r.candidates.filter((c) => c.kind === k).length;
      await ctx.progress(`Queued ${r.queued} post-mortem${r.queued === 1 ? "" : "s"}: ${n("breakout")} breakout, ${n("new_best")} new best, ${n("flop")} flop`);
    }
    return { queued: r.queued };
  },
});

export const postMortemInput = z.object({ postId: z.string().uuid(), kind: z.enum(["breakout", "flop", "new_best", "manual"]) });

export const postMortemJob = defineLlmJob({
  kind: "llm",
  id: "learn.post-mortem",
  agent: "analyst",
  description: "Drafts a post-mortem for one post: what happened, why, what to repeat and what to change.",
  input: postMortemInput,
  skill: "post-mortem",
  allowedTools: ["mcp__attentionos__learn_get_post_context", "mcp__attentionos__learn_get_feature_stats", "mcp__attentionos__learn_save_post_mortem", "Read"],
  defaultModel: "sonnet",
  maxTurns: 8,
  budgetUsd: 0.3,
  prompt: (ctx) =>
    [
      `Write a post-mortem for post ${ctx.input.postId} (flagged as ${ctx.input.kind.replace("_", " ")}).`,
      "1. Call learn_get_post_context for the numbers, the plan behind the post and the script.",
      "2. Call learn_get_feature_stats to compare its lane, hook pattern and format with the account's history.",
      "3. Read brand/lessons.md so you don't repeat a lesson that's already written down.",
      `4. Save with learn_save_post_mortem using the sections ${POST_MORTEM_SECTIONS.map((s) => `"## ${s}"`).join(", ")} and 1–3 lessons.`,
      "Wins and losses get the same depth. Use only numbers returned by the tools.",
    ].join("\n"),
});

export const postMortemBodySchema = z.string().min(200).max(8000);

export function checkPostMortemBody(body: string): string[] {
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
  return POST_MORTEM_SECTIONS.filter((s) => !headings.some((h) => h.startsWith(s.toLowerCase()))).map((s) => `missing the "## ${s}" section`);
}

export async function savePostMortem(ws: WorkspaceContext, p: { postId: string; kind: "breakout" | "flop" | "new_best" | "manual"; bodyMd: string; lessons: string[] }): Promise<{ id: string; x: number | null }> {
  const { posts } = await computeOwnScores(ws, { persist: false });
  const x = posts.find((q) => q.postId === p.postId)?.x ?? null;
  const [row] = await ws.sql`
    insert into post_mortems (workspace_id, post_id, kind, x_score, body_md, lessons, created_at)
    values (${ws.id}, ${p.postId}, ${p.kind}, ${x}, ${p.bodyMd}, ${jsonb(ws.sql, p.lessons.map((text) => ({ text, at: ws.now().toISOString() })))}, ${ws.now()})
    returning id`;
  return { id: row!.id as string, x };
}

export async function postContext(ws: WorkspaceContext, postId: string) {
  const d = await postDetail(ws, postId);
  if (!d) return null;
  const p = d.post;
  const [caption] = await ws.sql`select caption, utm_content from posts where id = ${p.postId} and workspace_id = ${ws.id}`;
  const [script] = p.contentId ? await ws.sql`select body, hook_text, hook_source from scripts where content_id = ${p.contentId} and workspace_id = ${ws.id} order by (status = 'approved') desc, version desc limit 1` : [];
  const { baselines } = await computeOwnScores(ws, { persist: false });
  return {
    post: { id: p.postId, platform: p.platform, publishedAt: p.publishedAt, url: p.url, x: p.x, rankOnPlatform: d.rank?.onPlatform ?? null, caption: caption?.caption ?? null, utmContent: caption?.utm_content ?? null, trialVariants: p.variants > 1 ? p.variants : undefined },
    numbers: { views: p.views, reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves, follows: p.follows, profileVisits: p.profileVisits, leads: p.funnel.leads, bookings: p.funnel.bookings, revenue: p.funnel.revenue, skipRate: p.skipRate, avgWatchS: p.avgWatchS, durationS: p.durationS, from: p.snapshot },
    rates: { ...p.rates, velocity: p.velocity, hold3s: p.hold3s },
    usual: d.norms,
    baseline: baselines[p.platform] ?? null,
    series: d.series.map((r) => ({ snapshot: r.label, hours: r.hours, views: r.views, comments: r.comments, follows: r.follows, x: r.x })),
    retention: d.retention ? { curve: d.retention, usual: d.usualRetention } : undefined,
    why: d.why,
    plan: d.plan,
    script: script ? { body: script.body, hook: script.hook_text, hookSource: script.hook_source } : null,
    features: p.features,
    featureStats: d.featureLines,
  };
}

export async function listPostMortems(ws: WorkspaceContext, f: { kind?: string; limit?: number } = {}) {
  const rows = await ws.sql`
    select pm.id, pm.post_id, pm.kind, pm.x_score, pm.body_md, pm.lessons, pm.created_at, p.url, p.platform
      from post_mortems pm left join posts p on p.id = pm.post_id
     where pm.workspace_id = ${ws.id} ${f.kind ? ws.sql`and pm.kind = ${f.kind}` : ws.sql``}
     order by pm.created_at desc limit ${f.limit ?? 10}`;
  return rows.map((r) => ({
    id: r.id as string, postId: r.post_id as string | null, kind: r.kind as string, x: num(r.x_score), url: r.url as string | null, platform: r.platform as string | null,
    bodyMd: r.body_md as string, lessons: r.lessons as { text: string }[], createdAt: iso(r.created_at),
  }));
}

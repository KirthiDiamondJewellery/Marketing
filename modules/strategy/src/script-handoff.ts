import { jsonb, moduleSettings, type WorkspaceContext } from "@attentionos/core";
import { enqueueRun } from "@attentionos/module-research";
import type { BriefRow } from "./repo.ts";
import { strategySettings } from "./settings.ts";

/**
 * Brief → scripts hand-off. After a brief is planned, the Strategist queues one `scripting.write-script` run per
 * filmable idea (by job id, so strategy never imports scripting). Scripts still go through the Copywriter's
 * approvals; this only makes sure the Film page has something to shoot.
 */

export const WRITE_SCRIPT_JOB = "scripting.write-script";
/** Starts a remix script once its source's teardown is in (scripting module). */
export const REMIX_READY_JOB = "scripting.remix-ready";
export const TEARDOWN_PREP_JOB = "research.teardown-prep";

/** The proven post a planned remix remakes. */
export function remixSourceOf(item: Pick<BriefRow, "brief">): string | null {
  const of = item.brief?.remixOf as { externalPostId?: unknown } | undefined;
  return item.brief?.kind === "remix" && typeof of?.externalPostId === "string" ? of.externalPostId : null;
}
/** Brief kinds that become a video someone films. */
export const FILMED_IDEA_KINDS = ["news", "remix", "talking_head", "offer"] as const;
/** content.kind values that are never filmed. */
const NOT_FILMED = new Set(["text", "carousel"]);

/** One key per content item, in any run state: a piece is only ever auto-scripted once. */
export const writeScriptKey = (contentId: string) => `write-script:${contentId}`;

export type ScriptTarget = Pick<BriefRow, "id" | "status" | "kind" | "filmBy" | "brief">;

export function isFilmable(item: ScriptTarget): boolean {
  if (NOT_FILMED.has(item.kind)) return false;
  const kind = item.brief?.kind;
  return typeof kind === "string" && (FILMED_IDEA_KINDS as readonly string[]).includes(kind);
}

/**
 * Picks which ideas get a script now: filmable ideas still at status idea, soonest deadline first (then slot order),
 * capped at what is left of today's allowance. Pure, so the cap is easy to test.
 */
export function pickScriptTargets<T extends ScriptTarget>(items: T[], opts: { maxPerDay: number; alreadyToday: number }): { picked: T[]; overCap: T[] } {
  const eligible = items
    .filter((i) => i.status === "idea" && isFilmable(i))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const fa = a.item.filmBy ? Date.parse(a.item.filmBy) : Number.POSITIVE_INFINITY;
      const fb = b.item.filmBy ? Date.parse(b.item.filmBy) : Number.POSITIVE_INFINITY;
      return fa - fb || a.index - b.index;
    })
    .map((x) => x.item);
  const room = Math.max(0, opts.maxPerDay - Math.max(0, opts.alreadyToday));
  return { picked: eligible.slice(0, room), overCap: eligible.slice(room) };
}

/** Scripts the Strategist already queued for this brief date (daily and batch editions share the allowance). */
export async function autoScriptsQueued(ws: WorkspaceContext, date: string): Promise<number> {
  const [row] = await ws.sql<{ n: number }[]>`
    select count(*)::int as n from agent_runs
     where workspace_id = ${ws.id} and job_id = ${WRITE_SCRIPT_JOB} and created_by = 'agent:strategist'
       and input ->> 'briefDate' = ${date} and status <> 'cancelled'`;
  return row?.n ?? 0;
}

export type ScriptHandoff = { queued: string[]; overCap: number; deduped: number };

/**
 * Queues `scripting.write-script` for the brief's filmable ideas, at most `autoScripts.maxPerDay` per brief date.
 * The dedupe key `write-script:<content id>` holds across every run state, so a re-run never writes twice.
 */
export async function queueScriptsForBrief(
  ws: WorkspaceContext,
  items: BriefRow[],
  opts: { date: string; mode: "daily" | "batch"; runId?: string | null },
): Promise<ScriptHandoff> {
  const s = strategySettings(ws).autoScripts;
  if (!s.enabled || s.maxPerDay === 0 || !moduleSettings(ws.config, "scripting").enabled) return { queued: [], overCap: 0, deduped: 0 };
  // Pieces that already had a script run (in any state) don't use up today's allowance.
  const keys = items.map((i) => writeScriptKey(i.id));
  const taken = new Set(
    keys.length
      ? (await ws.sql<{ dedupe_key: string }[]>`select dedupe_key from agent_runs where workspace_id = ${ws.id} and dedupe_key = any(${keys}::text[])`).map((r) => r.dedupe_key)
      : [],
  );
  let deduped = items.filter((i) => taken.has(writeScriptKey(i.id)) && i.status === "idea" && isFilmable(i)).length;
  const fresh = items.filter((i) => !taken.has(writeScriptKey(i.id)));
  const { picked, overCap } = pickScriptTargets(fresh, { maxPerDay: s.maxPerDay, alreadyToday: await autoScriptsQueued(ws, opts.date) });
  const runAfter = new Date(ws.now().getTime() + s.delayMinutes * 60_000);
  // A remix is written from its source's blueprint. When the source has none yet, the script waits (up to
  // waitForBlueprintMinutes) while research tears the post down; the teardown then starts the script early.
  const waitMs = Math.max(s.delayMinutes, strategySettings(ws).remixSources.waitForBlueprintMinutes) * 60_000;
  const sources = picked.map(remixSourceOf).filter((x): x is string => !!x);
  const ready = new Set(
    sources.length
      ? (await ws.sql<{ id: string }[]>`
          select distinct external_post_id::text as id from teardowns
           where workspace_id = ${ws.id} and external_post_id = any(${sources}::uuid[]) and fingerprint -> 'facets' ? 'blueprint'`).map((r) => r.id)
      : [],
  );
  const queued: string[] = [];
  for (const item of picked) {
    const key = writeScriptKey(item.id);
    const source = remixSourceOf(item);
    const waiting = source !== null && !ready.has(source);
    const rows = await ws.sql<{ id: string }[]>`
      insert into agent_runs (workspace_id, agent, job_id, trigger, status, input, dedupe_key, parent_run_id, run_after, created_by)
      select ${ws.id}, 'copywriter', ${WRITE_SCRIPT_JOB}, 'handoff', 'queued',
             ${jsonb(ws.sql, { contentId: item.id, briefDate: opts.date, mode: opts.mode })}, ${key}, ${opts.runId ?? null},
             ${waiting ? new Date(ws.now().getTime() + waitMs) : runAfter}, 'agent:strategist'
       where not exists (select 1 from agent_runs where workspace_id = ${ws.id} and dedupe_key = ${key})
      on conflict do nothing
      returning id`;
    if (rows[0]) queued.push(item.id);
    else deduped++;
    if (rows[0] && waiting) {
      await enqueueRun(ws, {
        jobId: TEARDOWN_PREP_JOB,
        agent: "analyst",
        input: { externalPostId: source, reuseBlueprint: true, then: { jobId: REMIX_READY_JOB, agent: "copywriter", input: { contentId: item.id } } },
        dedupeKey: `teardown-prep:${source}:${item.id}`,
        parentRunId: opts.runId ?? null,
        createdBy: "agent:strategist",
      });
    }
  }
  return { queued, overCap: overCap.length, deduped };
}

/** Replanning archives ideas; their scripts that haven't started yet are no longer wanted. */
export async function cancelQueuedScripts(ws: WorkspaceContext, contentIds: string[]): Promise<number> {
  if (!contentIds.length) return 0;
  const rows = await ws.sql`
    update agent_runs set status = 'cancelled', finished_at = ${ws.now()}, error = 'The idea was replanned.'
     where workspace_id = ${ws.id} and job_id = ${WRITE_SCRIPT_JOB} and status = 'queued'
       and input ->> 'contentId' = any(${contentIds}::text[])
     returning id`;
  return rows.length;
}

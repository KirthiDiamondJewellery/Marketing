"use server";

import { requireSession } from "@/server/auth";
import { refresh } from "next/cache";
import { enqueueRun, expediteRun, recordAgentEvent } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { id as idSchema, parse, text as textSchema } from "@/server/validate";
import type { ActionResult } from "./approvals";

const ACTOR = "user:studio";

/** "Mark as filmed": the script waits for its upload (content moves to filming, brief.filmed_at is set). */
export async function markFilmedAction(contentId: string, filmed = true): Promise<ActionResult> {
  await requireSession();
  if (!parse(z.object({ contentId: idSchema, filmed: z.boolean() }), { contentId, filmed })) return { ok: false, error: "Unknown script." };
  const ws = workspace();
  const rows = await ws.sql<{ title: string }[]>`
    update content set
      status = case when status = 'scripted' then 'filming' else status end,
      brief = case when ${filmed} then coalesce(brief, '{}'::jsonb) || jsonb_build_object('filmed_at', now()) else coalesce(brief, '{}'::jsonb) - 'filmed_at' end,
      updated_at = now()
     where workspace_id = ${ws.id} and id = ${contentId} and status in ('scripted', 'filming')
     returning title`;
  if (!rows[0]) return { ok: false, error: "That script isn't waiting to be filmed." };
  if (filmed) {
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: "user:studio", kind: "progress", message: `Filmed “${rows[0].title}”. Upload the take to start the edit`, data: { contentId } });
  }
  refresh();
  return { ok: true, message: filmed ? "Marked as filmed. Drop the take here to start the edit." : "Back on the list to film." };
}

const WRITE_SCRIPT = "scripting.write-script";
/** One click asks for at most this many scripts (each one is a full Copywriter run). */
const MAX_PER_CLICK = 5;

/**
 * Queues `scripting.write-script` for each piece that has no script on the way. The first request for a piece uses
 * the same key the Strategist's hand-off uses (`write-script:<content id>`), so a brief and a click never write it
 * twice; asking again later (after a rejection or a failed draft) gets a fresh key.
 */
async function queueScripts(contentIds: string[]): Promise<{ queued: string[]; busy: number }> {
  const ws = workspace();
  const ids = [...new Set(contentIds)].filter((id) => parse(idSchema, id) !== undefined);
  if (!ids.length) return { queued: [], busy: 0 };
  const activeRuns = await ws.sql<{ id: string; run_id: string; status: string }[]>`
    select input ->> 'contentId' as id, id as run_id, status from agent_runs
     where workspace_id = ${ws.id} and job_id = ${WRITE_SCRIPT} and status in ('queued', 'running') and input ->> 'contentId' = any(${ids}::text[])`;
  const active = new Set(activeRuns.map((r) => r.id));
  // Already waiting in the background (say, the Strategist's hand-off): you asked, so it starts now.
  for (const r of activeRuns) if (r.status === "queued") await expediteRun(ws.sql, ws.id, r.run_id);
  const rows = await ws.sql<{ id: string; title: string }[]>`
    select id, title from content where workspace_id = ${ws.id} and id = any(${ids}::uuid[]) and status in ('idea', 'scripted') and kind not in ('text', 'carousel')`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const queued: string[] = [];
  for (const id of ids) {
    if (active.has(id) || !byId.has(id)) continue;
    const base = { workspaceId: ws.id, jobId: WRITE_SCRIPT, agent: "copywriter", input: { contentId: id }, trigger: "manual" as const, createdBy: ACTOR };
    let r = await enqueueRun(ws.sql, { ...base, dedupeKey: `write-script:${id}` });
    if (r.deduped) r = await enqueueRun(ws.sql, { ...base, dedupeKey: `write-script:${id}:${Date.now().toString(36)}` });
    if (!r.deduped) queued.push(id);
  }
  if (queued.length) {
    const first = byId.get(queued[0]!)!.title;
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id,
      agent: ACTOR,
      kind: "handoff",
      message: queued.length === 1 ? `Asked the Copywriter for a script: “${first}”` : `Asked the Copywriter for ${queued.length} scripts, starting with “${first}”`,
      data: { to: "copywriter", contentIds: queued },
    });
  }
  return { queued, busy: ids.filter((id) => active.has(id)).length };
}

/** "Write script" on one idea, or "Write scripts for today" on the ideas without one (soonest first, up to 5). */
export async function writeScriptsAction(contentIds: string[]): Promise<ActionResult> {
  await requireSession();
  // Any length is accepted (only the first MAX_PER_CLICK are used); entries that aren't ids are skipped below.
  if (!parse(z.array(z.string().max(64)).min(1).max(500), contentIds)) return { ok: false, error: "Pick an idea to script." };
  try {
    const { queued, busy } = await queueScripts(contentIds.slice(0, MAX_PER_CLICK));
    refresh();
    if (!queued.length) return busy ? { ok: true, message: "The Copywriter is already on it." } : { ok: false, error: "Those ideas can't be scripted from here any more." };
    return { ok: true, message: queued.length === 1 ? "The Copywriter is writing it. It comes back here for your OK." : `The Copywriter is writing ${queued.length} scripts. Each one comes back here for your OK.` };
  } catch (e) {
    console.error("[studio] write scripts failed:", e);
    return { ok: false, error: "Couldn't ask the Copywriter. Check the database connection and try again." };
  }
}

/** "New idea": a working title and optional notes become a content item, and the Copywriter scripts it. */
export async function newIdeaAction(raw: { title?: string; notes?: string }): Promise<ActionResult & { id?: string }> {
  await requireSession();
  const input = parse(z.object({ title: textSchema(2000).optional(), notes: textSchema().optional() }), raw);
  if (!input) return { ok: false, error: "That idea is too long. Shorten the title or notes and try again." };
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim();
  const notes = String(input.notes ?? "").trim().slice(0, 1000);
  if (title.length < 4) return { ok: false, error: "Give the idea a working title (a few words)." };
  if (title.length > 140) return { ok: false, error: "Keep the title under 140 characters." };
  const ws = workspace();
  try {
    const [row] = await ws.sql<{ id: string }[]>`
      insert into content (workspace_id, title, status, kind, source_refs, brief, created_by)
      values (${ws.id}, ${title}, 'idea', 'reel', ${ws.sql.json([{ type: "manual" }] as never)},
              ${ws.sql.json({ header: title, kind: "talking_head", source: "studio", ...(notes ? { why: notes, notes } : {}) } as never)}, ${ACTOR})
      returning id`;
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: `Added an idea: “${title}”`, data: { contentId: row!.id } });
    const { queued } = await queueScripts([row!.id]);
    refresh();
    return { ok: true, id: row!.id, message: queued.length ? "Added. The Copywriter is writing the script." : "Added to your ideas." };
  } catch (e) {
    console.error("[studio] new idea failed:", e);
    return { ok: false, error: "Couldn't save the idea. Check the database connection and try again." };
  }
}

"use server";

import { requireSession } from "@/server/auth";
import { revalidatePath } from "next/cache";
import { decideApproval, enqueueRun, recordAgentEvent } from "@attentionos/db";
import { FUNNEL_STAGES } from "@attentionos/core";
import { workspace } from "@/server/workspace";
import { fmtWeekdayTime } from "@/components/content/format";
import { z } from "zod";
import { BAD_REQUEST, parse, ref as refSchema } from "@/server/validate";

/**
 * Studio work-surface mutations: calendar reschedules, new ideas and edit revision notes.
 * Everything a person does here is recorded as `user:studio` and shows up in the agent stream.
 */

export type ActionResult = { ok: true; message: string; id?: string } | { ok: false; message: string };

const ACTOR = "user:studio";
const MOVABLE = ["draft", "queued", "scheduled", "assist"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rescheduleInput = z.object({ postIds: z.array(z.string().max(64)).max(500), atIso: z.string().max(64) });
/** Form fields are strings (or absent); a file in a text field is not a valid idea. */
const formText = (max: number) => z.string().max(max).nullable();
const ideaInput = z.object({ title: formText(2_000), angle: formText(5_000), lane: formText(200), funnel: formText(100), why: formText(10_000) });
const revisionInput = z.object({ ref: refSchema, notes: z.string().max(20_000) });
const statusInput = z.object({ contentId: z.string().max(64), status: z.string().max(64) });

// ---------------------------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------------------------

/** Moves not-yet-published posts to a new time. Published posts never move. */
export async function reschedulePosts(rawPostIds: string[], rawAtIso: string): Promise<ActionResult> {
  await requireSession();
  const args = parse(rescheduleInput, { postIds: rawPostIds, atIso: rawAtIso });
  if (!args) return { ok: false, message: BAD_REQUEST };
  const ws = workspace();
  const ids = [...new Set(args.postIds)].filter((id) => UUID.test(id));
  if (!ids.length) return { ok: false, message: "Nothing to move." };
  const at = new Date(args.atIso);
  if (Number.isNaN(at.getTime())) return { ok: false, message: "That time isn't valid." };
  if (at.getTime() < Date.now() - 60_000) return { ok: false, message: "Pick a time that hasn't passed yet." };

  const rows = await ws.sql<{ id: string; status: string; title: string | null; platform: string }[]>`
    select p.id, p.status, c.title, p.platform from posts p left join content c on c.id = p.content_id
     where p.workspace_id = ${ws.id} and p.id = any(${ids}::uuid[])`;
  const movable = rows.filter((r) => MOVABLE.includes(r.status));
  if (!movable.length) {
    return { ok: false, message: rows.some((r) => r.status === "published") ? "Published posts stay where they are." : "These posts can't be moved." };
  }
  await ws.sql`
    update posts set scheduled_at = ${at}, updated_at = now()
     where workspace_id = ${ws.id} and id = any(${movable.map((r) => r.id)}::uuid[]) and status = any(${MOVABLE})`;

  const when = fmtWeekdayTime(at, ws.config.workspace.timezone);
  const title = movable[0]?.title;
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "publisher",
    kind: "progress",
    message: `Moved ${title ? `“${title}”` : `${movable.length} post${movable.length === 1 ? "" : "s"}`} to ${when}`,
    data: { by: ACTOR, postIds: movable.map((r) => r.id), at: at.toISOString() },
  });
  revalidatePath("/calendar");
  revalidatePath("/content", "layout");
  const skipped = rows.length - movable.length;
  return { ok: true, message: `Moved to ${when}${skipped ? ` (${skipped} already out stayed put)` : ""}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------------------------------------------

export async function createIdea(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  await requireSession();
  if (!(form instanceof FormData)) return { ok: false, message: BAD_REQUEST };
  const fields = parse(ideaInput, { title: form.get("title"), angle: form.get("angle"), lane: form.get("lane"), funnel: form.get("funnel"), why: form.get("why") });
  if (!fields) return { ok: false, message: "Check the idea fields: one of them is too long or isn't text." };
  const ws = workspace();
  const title = (fields.title ?? "").trim();
  const angle = (fields.angle ?? "").trim() || null;
  const lane = (fields.lane ?? "").trim() || null;
  const funnelRaw = (fields.funnel ?? "").trim();
  const why = (fields.why ?? "").trim();
  if (title.length < 4) return { ok: false, message: "Give the idea a working title (a few words)." };
  if (title.length > 140) return { ok: false, message: "Keep the title under 140 characters." };
  const funnel = (FUNNEL_STAGES as readonly string[]).includes(funnelRaw) ? funnelRaw : null;
  const [row] = await ws.sql<{ id: string }[]>`
    insert into content (workspace_id, title, status, kind, lane, funnel_stage, angle, source_refs, brief, created_by)
    values (${ws.id}, ${title}, 'idea', 'reel', ${lane}, ${funnel}, ${angle}, ${ws.sql.json([{ type: "manual" }] as never)},
            ${why ? ws.sql.json({ header: title, why } as never) : null}, ${ACTOR})
    returning id`;
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: ACTOR,
    kind: "progress",
    message: `Added an idea: “${title}”`,
    data: { contentId: row!.id },
  });
  revalidatePath("/content");
  return { ok: true, message: "Idea added", id: row!.id };
}

// ---------------------------------------------------------------------------------------------------------------
// Edit revisions
// ---------------------------------------------------------------------------------------------------------------

type EditRow = { id: string; ref: string; version: number; status: string; output_asset_id: string | null; content_id: string | null; notes: unknown };

/**
 * "rf-12 v2: tighten the hook". Queues `editing.revise` (the Art Director resumes the edit's session). If the render
 * is waiting on an approval, that approval is marked "asked for changes" so nothing goes out meanwhile.
 */
export async function addRevisionNote(rawRef: string, notesRaw: string): Promise<ActionResult> {
  await requireSession();
  const args = parse(revisionInput, { ref: rawRef, notes: notesRaw });
  if (!args) return { ok: false, message: typeof notesRaw === "string" && notesRaw.length > 20_000 ? "Keep the note under 2,000 characters." : BAD_REQUEST };
  const { ref } = args;
  const ws = workspace();
  const notes = args.notes.trim();
  if (notes.length < 3) return { ok: false, message: "Write what should change." };
  if (notes.length > 2000) return { ok: false, message: "Keep the note under 2,000 characters." };
  const [job] = await ws.sql<EditRow[]>`
    select id, ref, version, status, output_asset_id, content_id, notes from edit_jobs where workspace_id = ${ws.id} and ref = ${ref.toLowerCase()}`;
  if (!job) return { ok: false, message: `There is no edit called ${ref}.` };
  if (!job.output_asset_id && !["review", "approved"].includes(job.status)) {
    return { ok: false, message: `${job.ref} hasn't been rendered yet, so there's nothing to revise.` };
  }
  const fromVersion = job.version;
  const source = { channel: "studio" };

  const [pending] = await ws.sql<{ ref: string; run_id: string | null; waiting: boolean }[]>`
    select a.ref, a.run_id,
           exists (select 1 from agent_runs r where r.id = a.run_id and r.status = 'waiting_approval') as waiting
      from approvals a
     where a.workspace_id = ${ws.id} and a.status = 'pending' and a.kind = 'edit' and a.subject_id = ${job.id}
     order by a.requested_at desc limit 1`;

  // Show the note right away (the revise job records the same note idempotently when it starts).
  const prior = Array.isArray(job.notes) ? (job.notes as Record<string, unknown>[]) : [];
  const note = { at: new Date().toISOString(), by: ACTOR, version: fromVersion, text: notes, source };
  await ws.sql`update edit_jobs set notes = ${ws.sql.json([...prior, note] as never)}, updated_at = now() where workspace_id = ${ws.id} and id = ${job.id}`;

  if (pending?.waiting) {
    // Deciding "revised" puts the waiting render run back on the queue with the note (one path, no duplicates).
    await decideApproval(ws.sql, ws.id, { refOrId: pending.ref, decision: "revised", actor: ACTOR, note: notes });
  } else {
    await enqueueRun(ws.sql, {
      workspaceId: ws.id,
      jobId: "editing.revise",
      agent: "art_director",
      input: { ref: job.ref, fromVersion, notes, source },
      trigger: "manual",
      createdBy: ACTOR,
    });
    if (pending) await decideApproval(ws.sql, ws.id, { refOrId: pending.ref, decision: "revised", actor: ACTOR, note: notes });
  }
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "art_director",
    kind: "progress",
    message: `Got your notes on ${job.ref} v${fromVersion}; v${fromVersion + 1} is next`,
    data: { by: ACTOR, ref: job.ref, fromVersion },
  });
  if (job.content_id) revalidatePath(`/content/${job.content_id}`);
  return { ok: true, message: `Sent to the Art Director: ${job.ref} v${fromVersion + 1} is next` };
}

/** Moves a content item along the lifecycle by hand (e.g. "I filmed it"). */
export async function setContentStatus(rawContentId: string, rawStatus: string): Promise<ActionResult> {
  await requireSession();
  const args = parse(statusInput, { contentId: rawContentId, status: rawStatus });
  if (!args) return { ok: false, message: "That change isn't possible." };
  const { contentId, status } = args;
  const ws = workspace();
  const allowed = ["idea", "scripted", "filming", "editing", "review", "scheduled", "published", "measured", "archived"];
  if (!UUID.test(contentId) || !allowed.includes(status)) return { ok: false, message: "That change isn't possible." };
  const [row] = await ws.sql<{ title: string }[]>`
    update content set status = ${status}, updated_at = now() where workspace_id = ${ws.id} and id = ${contentId} returning title`;
  if (!row) return { ok: false, message: "That piece no longer exists." };
  await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: `Moved “${row.title}” to ${status}`, data: { contentId } });
  revalidatePath("/content");
  revalidatePath(`/content/${contentId}`);
  return { ok: true, message: status === "archived" ? "Archived" : `Moved to ${status}` };
}

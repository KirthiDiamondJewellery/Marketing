"use server";

import { requireSession } from "@/server/auth";
import { refresh } from "next/cache";
import { enqueueRun, recordAgentEvent } from "@attentionos/db";
import { cancelEdit, kickAdvance, linkUpload, restartUpload, retryEdit } from "@attentionos/module-production/repo";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, id as idSchema, parse } from "@/server/validate";
import type { ActionResult } from "./approvals";

const ACTOR = "user:studio" as const;
const editRef = z.string().regex(/^rf-\d+$/i);

function problem(e: unknown, fallback: string): { ok: false; error: string } {
  console.error("[studio] production:", e);
  const msg = e instanceof Error ? e.message : "";
  return { ok: false, error: msg && msg.length < 200 && !/sql|relation|column/i.test(msg) ? msg : fallback };
}

/**
 * Files a take under a script (or none: "No script — just edit it") and starts its edit right away. A second take of
 * a script already in the edit is kept as an extra take unless `replace` is set ("Edit this take instead").
 */
export async function linkUploadAction(uploadId: string, contentId: string | null, opts: { replace?: boolean } = {}): Promise<ActionResult & { ref?: string | null; role?: string }> {
  await requireSession();
  const args = parse(z.object({ uploadId: idSchema, contentId: idSchema.nullable(), opts: z.object({ replace: z.boolean().optional() }) }), { uploadId, contentId, opts });
  if (!args) return { ok: false, error: "Unknown take or script." };
  const ws = workspace();
  try {
    const r = await linkUpload(ws, { uploadId, contentId, actor: ACTOR, replace: opts.replace === true });
    refresh();
    return { ok: true, message: r.message, ref: r.ref, role: r.role };
  } catch (e) {
    return problem(e, "Couldn't link that take. Try again.");
  }
}

/** Hides a take from the Film list (the file stays in media/raw). */
export async function dismissUploadAction(uploadId: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, uploadId)) return { ok: false, error: "Unknown take." };
  const ws = workspace();
  const rows = await ws.sql`update production_uploads set status = 'dismissed', updated_at = now()
                             where workspace_id = ${ws.id} and id = ${uploadId} and (role is distinct from 'edit' or edit_job_id is null) returning id`;
  refresh();
  return rows.length ? { ok: true, message: "Removed from the list. The file stays in media/raw." } : { ok: false, error: "That take is being edited. Stop the edit first." };
}

/** Starts a stopped take's edit again. */
export async function restartUploadAction(uploadId: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, uploadId)) return { ok: false, error: "Unknown take." };
  try {
    const r = await restartUpload(workspace(), uploadId, ACTOR);
    refresh();
    return { ok: true, message: r.message };
  } catch (e) {
    return problem(e, "Couldn't start it again.");
  }
}

export async function retryEditAction(ref: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(editRef, ref)) return { ok: false, error: "Unknown edit." };
  try {
    const r = await retryEdit(workspace(), ref.toLowerCase(), ACTOR);
    refresh();
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message };
  } catch (e) {
    return problem(e, "Couldn't retry that edit.");
  }
}

export async function cancelEditAction(ref: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(editRef, ref)) return { ok: false, error: "Unknown edit." };
  const ws = workspace();
  const [e] = await ws.sql<{ id: string }[]>`select id from edit_jobs where workspace_id = ${ws.id} and ref = ${ref.toLowerCase()}`;
  if (!e) return { ok: false, error: "Unknown edit." };
  const stopped = await cancelEdit(ws, e.id, ACTOR, "Stopped from the edit queue");
  if (!stopped) return { ok: false, error: "That edit is already approved or stopped." };
  await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: `Stopped ${stopped}`, data: { ref: stopped } });
  refresh();
  return { ok: true, message: `Stopped ${stopped}.` };
}

/** Tries scheduling an approved video again (after connecting an account, say). */
export async function retryScheduleAction(ref: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(editRef, ref)) return { ok: false, error: "Unknown edit." };
  const ws = workspace();
  const [e] = await ws.sql<{ id: string; version: number }[]>`select id, version from edit_jobs where workspace_id = ${ws.id} and ref = ${ref.toLowerCase()} and status = 'approved'`;
  if (!e) return { ok: false, error: "Only an approved video can be scheduled." };
  await ws.sql`update production_releases set status = 'approved', updated_at = now() where workspace_id = ${ws.id} and edit_job_id = ${e.id} and version = ${e.version} and status in ('failed', 'partial')`;
  await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: "production.schedule-approved", agent: "publisher", input: { ref: ref.toLowerCase(), version: e.version }, trigger: "manual", createdBy: ACTOR });
  refresh();
  return { ok: true, message: "Scheduling it again." };
}

/** "Review cuts before editing" (off by default). Saved live: the next pipeline check uses it, no restart. */
export async function setReviewCutsAction(on: boolean): Promise<ActionResult> {
  await requireSession();
  if (!parse(z.boolean(), on)) return { ok: false, error: BAD_REQUEST };
  const ws = workspace();
  await ws.sql`
    insert into settings (workspace_id, key, value, updated_at) values (${ws.id}, 'production:settings', ${ws.sql.json({ reviewCuts: on === true })}, now())
    on conflict (workspace_id, key) do update set value = settings.value || excluded.value, updated_at = now()`;
  await kickAdvance(ws);
  refresh();
  return { ok: true, message: on ? "You'll review the cuts before each edit is planned." : "Cuts are approved for you. You'll only see the finished video." };
}

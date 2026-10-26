import { jsonb, nextRef, type Actor, type Sql, type WorkspaceContext } from "@attentionos/core";
import { enqueueRun, recordAgentEvent, RUN_PRIORITY } from "@attentionos/db";
import type { MatchResult } from "./match.ts";

/** SQL for production_uploads and production_releases. Every query filters by workspace_id. */

export type UploadStatus = "matching" | "suggested" | "linked" | "unmatched" | "failed" | "dismissed";

export type UploadRow = {
  id: string;
  workspace_id: string;
  asset_id: string | null;
  file_name: string;
  bytes: string | number | null;
  duration_s: string | number | null;
  status: UploadStatus;
  role: "edit" | "take" | null;
  transcript: string | null;
  candidates: MatchResult[];
  content_id: string | null;
  confidence: string | number | null;
  linked_by: string | null;
  linked_at: Date | null;
  edit_job_id: string | null;
  error: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

export type ReleaseSlot = { platform: string; scheduledAt: string | null; mode: "auto" | "assist" };
export type ReleaseOutcome = { platform: string; outcome: string; postId?: string; message: string; scheduledAt?: string | null; mode?: "auto" | "assist" };
export type ReleaseStatus = "proposed" | "ready" | "approved" | "scheduling" | "scheduled" | "partial" | "failed";

export type ReleaseRow = {
  id: string;
  workspace_id: string;
  edit_job_id: string;
  content_id: string | null;
  version: number;
  approval_ref: string | null;
  plan_id: string | null;
  status: ReleaseStatus;
  slots: ReleaseSlot[];
  captions: Record<string, string>;
  outcomes: ReleaseOutcome[];
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type Ws = Pick<WorkspaceContext, "id" | "sql">;

export async function getUpload(ws: Ws, id: string): Promise<UploadRow | undefined> {
  const [row] = await ws.sql<UploadRow[]>`select * from production_uploads where workspace_id = ${ws.id} and id = ${id}`;
  return row;
}

export async function insertUpload(ws: Ws, u: { assetId: string; fileName: string; bytes: number | null; createdBy: string }): Promise<UploadRow> {
  const [row] = await ws.sql<UploadRow[]>`
    insert into production_uploads (workspace_id, asset_id, file_name, bytes, created_by)
    values (${ws.id}, ${u.assetId}, ${u.fileName}, ${u.bytes}, ${u.createdBy})
    on conflict (asset_id) where asset_id is not null do update set updated_at = now()
    returning *`;
  return row!;
}

export async function updateUpload(ws: Ws, id: string, patch: Partial<Pick<UploadRow, "status" | "role" | "transcript" | "content_id" | "linked_by" | "edit_job_id" | "error">> & { candidates?: MatchResult[]; confidence?: number | null; duration_s?: number | null; linked_at?: Date | null }): Promise<void> {
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  if (!cols.length) return;
  const values: Record<string, unknown> = {};
  for (const c of cols) values[c] = c === "candidates" ? jsonb(ws.sql, patch[c]) : patch[c];
  await ws.sql`update production_uploads set ${ws.sql(values as never, cols as never)}, updated_at = now() where workspace_id = ${ws.id} and id = ${id}`;
}

export async function getRelease(ws: Ws, editJobId: string, version: number): Promise<ReleaseRow | undefined> {
  const [row] = await ws.sql<ReleaseRow[]>`select * from production_releases where workspace_id = ${ws.id} and edit_job_id = ${editJobId} and version = ${version}`;
  return row;
}

export async function upsertRelease(
  ws: Ws,
  r: { editJobId: string; contentId: string | null; version: number; approvalRef?: string | null; slots?: ReleaseSlot[]; captions?: Record<string, string> },
): Promise<ReleaseRow> {
  const [row] = await ws.sql<ReleaseRow[]>`
    insert into production_releases (workspace_id, edit_job_id, content_id, version, approval_ref, slots, captions)
    values (${ws.id}, ${r.editJobId}, ${r.contentId}, ${r.version}, ${r.approvalRef ?? null}, ${jsonb(ws.sql, r.slots ?? [])}, ${jsonb(ws.sql, r.captions ?? {})})
    on conflict (edit_job_id, version) do update set
      approval_ref = coalesce(excluded.approval_ref, production_releases.approval_ref),
      slots = case when production_releases.status = 'proposed' and ${r.slots !== undefined} then excluded.slots else production_releases.slots end,
      captions = case when ${r.captions !== undefined} then excluded.captions else production_releases.captions end,
      updated_at = now()
    returning *`;
  return row!;
}

export async function updateRelease(ws: Ws, id: string, patch: { status?: ReleaseStatus; outcomes?: ReleaseOutcome[]; slots?: ReleaseSlot[]; approved_by?: string; approved_at?: Date; plan_id?: string }): Promise<void> {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) values[k] = k === "outcomes" || k === "slots" ? jsonb(ws.sql, v) : v;
  const cols = Object.keys(values);
  if (!cols.length) return;
  await ws.sql`update production_releases set ${ws.sql(values as never, cols as never)}, updated_at = now() where workspace_id = ${ws.id} and id = ${id}`;
}

/** The content row an upload is filed under; "No script — just edit it" creates one from the file name. */
export async function ensureContentFor(ws: Ws, contentId: string | null, fileName: string, actor: string): Promise<{ id: string; title: string; template: string | null; created: boolean }> {
  if (contentId) {
    const [c] = await ws.sql<{ id: string; title: string; template: string | null }[]>`select id, title, template from content where workspace_id = ${ws.id} and id = ${contentId}`;
    if (!c) throw new Error("That script doesn't exist in this workspace.");
    return { ...c, created: false };
  }
  const title = fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").replace(/\s+\d{8}-\d{6}$/, "").trim() || "Untitled take";
  const [c] = await ws.sql<{ id: string; title: string; template: string | null }[]>`
    insert into content (workspace_id, title, status, kind, created_by) values (${ws.id}, ${title}, 'editing', 'reel', ${actor})
    returning id, title, template`;
  return { ...c!, created: true };
}

export type LinkResult = { uploadId: string; role: "edit" | "take"; ref: string | null; contentId: string; title: string; message: string };

/**
 * Files a take under a script and starts its edit: creates the edit (rf-N) for the raw asset, moves the content to
 * "editing" and queues `editing.prep` ahead of later deadlines (queue order = film-by). A second take of a script
 * whose edit is already running is kept as an extra take (`role = take`), unless `replace` swaps it in.
 *
 * Studio's upload route and link action run the same steps in SQL (apps/studio/src/server/queries/production.ts).
 */
export async function linkUpload(
  ws: Ws & Partial<Pick<WorkspaceContext, "config">>,
  input: { uploadId: string; contentId: string | null; actor: Actor | "auto"; confidence?: number | null; replace?: boolean; defaultFormat?: string },
): Promise<LinkResult> {
  const up = await getUpload(ws, input.uploadId);
  if (!up) throw new Error("That upload doesn't exist.");
  if (!up.asset_id) throw new Error("The uploaded file is gone. Upload it again.");
  if (up.status === "linked" && up.content_id === input.contentId && up.role && !(input.replace && up.role === "take")) {
    const [e] = up.edit_job_id ? await ws.sql<{ ref: string }[]>`select ref from edit_jobs where workspace_id = ${ws.id} and id = ${up.edit_job_id}` : [];
    return { uploadId: up.id, role: up.role, ref: e?.ref ?? null, contentId: up.content_id!, title: "", message: "Already linked." };
  }
  // Re-linking an upload that already started an edit: stop that edit first.
  if (up.edit_job_id) await cancelEdit(ws, up.edit_job_id, input.actor === "auto" ? "system" : input.actor, "Linked to a different script");
  const content = await ensureContentFor(ws, input.contentId, up.file_name, input.actor === "auto" ? "agent:art_director" : input.actor);
  const [running] = await ws.sql<{ id: string; ref: string; status: string; upload_id: string | null }[]>`
    select e.id, e.ref, e.status, u.id as upload_id from edit_jobs e
      left join production_uploads u on u.edit_job_id = e.id and u.workspace_id = e.workspace_id
     where e.workspace_id = ${ws.id} and e.content_id = ${content.id} and e.status not in ('cancelled', 'failed')
       and e.id is distinct from ${up.edit_job_id}
     order by e.created_at desc limit 1`;
  const linkedBy = input.actor === "auto" ? "auto" : input.actor;
  if (running && !input.replace) {
    await updateUpload(ws, up.id, { status: "linked", role: "take", content_id: content.id, linked_by: linkedBy, linked_at: new Date(), edit_job_id: null, error: null, ...(input.confidence != null ? { confidence: input.confidence } : {}) });
    return { uploadId: up.id, role: "take", ref: running.ref, contentId: content.id, title: content.title, message: `Kept as another take of “${content.title}”. ${running.ref} is already being edited.` };
  }
  if (running && input.replace && ["review", "approved"].includes(running.status)) {
    throw new Error(`“${content.title}” is already edited (${running.ref}). Ask for changes on it in Approvals instead.`);
  }
  if (running && input.replace) {
    await cancelEdit(ws, running.id, input.actor === "auto" ? "system" : input.actor, "Switched to another take");
    if (running.upload_id) await updateUpload(ws, running.upload_id, { role: "take", edit_job_id: null });
  }
  const format = content.template ?? ((ws.config?.modules.editing?.settings as { defaultFormat?: string } | undefined)?.defaultFormat ?? input.defaultFormat ?? "raw-talking-head");
  const ref = await ws.sql.begin(async (tx) => {
    const r = await nextRef(tx as unknown as Sql, ws.id, "rf");
    const [job] = await tx<{ id: string }[]>`
      insert into edit_jobs (workspace_id, content_id, ref, engine, format, version, status, source_asset_id, preflight)
      values (${ws.id}, ${content.id}, ${r}, 'cut', ${format}, 1, 'queued', ${up.asset_id}, ${tx.json({ signoffs: [] } as never)})
      returning id`;
    await tx`update media_assets set content_id = ${content.id} where workspace_id = ${ws.id} and id = ${up.asset_id}`;
    await tx`update content set status = 'editing', template = coalesce(template, ${format}), updated_at = now()
              where workspace_id = ${ws.id} and id = ${content.id} and status in ('idea', 'scripted', 'filming', 'editing')`;
    await tx`update production_uploads set status = 'linked', role = 'edit', content_id = ${content.id}, linked_by = ${linkedBy}, linked_at = now(),
                    edit_job_id = ${job!.id}, error = null, confidence = coalesce(${input.confidence ?? null}, confidence), updated_at = now()
              where workspace_id = ${ws.id} and id = ${up.id}`;
    return r;
  });
  await enqueuePrep(ws, ref, content.id, input.actor === "auto" ? "agent:art_director" : input.actor);
  await kickAdvance(ws);
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "art_director",
    kind: "progress",
    message: `${input.actor === "auto" ? "Matched" : "Linked"} ${up.file_name} to “${content.title}”. Editing it as ${ref}`,
    data: { ref, uploadId: up.id, contentId: content.id, confidence: input.confidence ?? null },
  });
  return { uploadId: up.id, role: "edit", ref, contentId: content.id, title: content.title, message: `Editing “${content.title}” as ${ref}.` };
}

/**
 * Queues prep. Runs of the same priority are claimed by `run_after`, so earlier film-by deadlines get an earlier
 * `run_after` (up to a week back): the owner's edits are worked in deadline order.
 */
export async function enqueuePrep(ws: Ws, ref: string, contentId: string | null, actor: string): Promise<string> {
  const [row] = await ws.sql<{ at: Date }[]>`
    select now() - greatest(interval '0', interval '7 days' - (coalesce(film_by, now() + interval '7 days') - now())) as at
      from content where workspace_id = ${ws.id} and id = ${contentId}`;
  const run = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: "editing.prep",
    agent: "art_director",
    input: { ref },
    trigger: "event",
    createdBy: actor,
    dedupeKey: `editing:${ref}:prep`,
    ...(row ? { runAfter: row.at } : {}),
  });
  return run.id;
}

/** Stops an edit: marks it cancelled and stops its queued or running work. */
export async function cancelEdit(ws: Ws, editJobId: string, actor: string, why: string): Promise<string | null> {
  const [e] = await ws.sql<{ ref: string }[]>`
    update edit_jobs set status = 'cancelled', updated_at = now()
     where workspace_id = ${ws.id} and id = ${editJobId} and status not in ('approved', 'cancelled')
     returning ref`;
  if (!e) return null;
  await ws.sql`
    update agent_runs set status = 'cancelled', finished_at = now(), error = ${why}
     where workspace_id = ${ws.id} and job_id like 'editing.%' and input->>'ref' = ${e.ref} and status in ('queued', 'running', 'waiting_approval')`;
  await ws.sql`
    update approvals set status = 'expired', decided_at = now(), decided_by = ${actor}, decision_note = ${why}
     where workspace_id = ${ws.id} and subject_id = ${editJobId} and status = 'pending'`;
  return e.ref;
}

/**
 * Wakes the pipeline check soon (deduplicated per few seconds). It drives the owner's own uploads and edits, so it
 * (and the prep, plan, render and scheduling runs it starts, which inherit its priority) runs ahead of background work.
 */
export async function kickAdvance(ws: Ws, delayS = 0, everyS = 12): Promise<void> {
  const at = Date.now() + delayS * 1000;
  const bucket = Math.floor(at / (everyS * 1000));
  await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: "production.advance",
    agent: "art_director",
    input: {},
    trigger: "event",
    createdBy: "system",
    dedupeKey: `production:advance:${bucket}`,
    runAfter: new Date(at),
    maxAttempts: 1,
    priority: RUN_PRIORITY.user,
  });
}

/**
 * Retry an edit that stopped: puts its latest failed step (prep, plan, render or a revision) back on the queue, or
 * asks for a fresh plan when the last one didn't pass its checks.
 */
export async function retryEdit(ws: Ws, ref: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const [e] = await ws.sql<{ id: string; status: string; content_id: string | null }[]>`select id, status, content_id from edit_jobs where workspace_id = ${ws.id} and ref = ${ref}`;
  if (!e) return { ok: false, message: "That edit doesn't exist." };
  if (e.status === "cancelled") return { ok: false, message: "This edit was stopped. Start it again from the take." };
  const [active] = await ws.sql<{ id: string }[]>`
    select id from agent_runs where workspace_id = ${ws.id} and job_id like 'editing.%' and input->>'ref' = ${ref} and status in ('queued', 'running') limit 1`;
  if (active) return { ok: true, message: "It's already being worked on." };
  const [failed] = await ws.sql<{ id: string; job_id: string }[]>`
    select id, job_id from agent_runs where workspace_id = ${ws.id} and job_id like 'editing.%' and input->>'ref' = ${ref}
     order by created_at desc limit 1`;
  const STEP: Record<string, string> = { "editing.prep": "prep", "editing.plan": "the plan", "editing.render": "the render", "editing.revise": "the changes" };
  const [requeued] = failed
    ? await ws.sql<{ id: string }[]>`
        update agent_runs set status = 'queued', claimed_by = null, finished_at = null, error = null, run_after = now(),
               max_attempts = greatest(max_attempts, attempts + 1)
         where workspace_id = ${ws.id} and id = ${failed.id} and status in ('failed', 'cancelled') returning id`
    : [];
  if (requeued) {
    if (failed!.job_id === "editing.prep") await ws.sql`update edit_jobs set status = 'queued', updated_at = now() where workspace_id = ${ws.id} and id = ${e.id}`;
    if (failed!.job_id === "editing.plan" && e.status === "failed") await ws.sql`update edit_jobs set status = 'planning', updated_at = now() where workspace_id = ${ws.id} and id = ${e.id}`;
  } else {
    await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: "editing.plan", agent: "art_director", input: { ref }, trigger: "manual", createdBy: actor, dedupeKey: `editing:${ref}:plan:retry:${Date.now()}` });
    await ws.sql`update edit_jobs set status = 'planning', updated_at = now() where workspace_id = ${ws.id} and id = ${e.id} and status in ('failed', 'planning')`;
  }
  await ws.sql`update production_uploads set error = null, updated_at = now() where workspace_id = ${ws.id} and edit_job_id = ${e.id}`;
  await kickAdvance(ws);
  await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: actor, kind: "progress", message: `Asked the Art Director to retry ${requeued ? STEP[failed!.job_id] ?? "the last step" : "the plan"} for ${ref}`, data: { ref } });
  return { ok: true, message: `Retrying ${requeued ? STEP[failed!.job_id] ?? "the last step" : "the plan"}.` };
}

/** Starts a stopped take's edit again from the beginning (a new rf ref). */
export async function restartUpload(ws: Ws & Partial<Pick<WorkspaceContext, "config">>, uploadId: string, actor: Actor): Promise<LinkResult> {
  const up = await getUpload(ws, uploadId);
  if (!up) throw new Error("That upload doesn't exist.");
  await ws.sql`update production_uploads set status = 'suggested', role = null, edit_job_id = null, error = null, updated_at = now() where workspace_id = ${ws.id} and id = ${uploadId}`;
  return linkUpload(ws, { uploadId, contentId: up.content_id, actor, replace: true });
}

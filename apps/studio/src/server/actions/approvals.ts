"use server";

import { requireSession } from "@/server/auth";
import { randomUUID } from "node:crypto";
import { agentSettings } from "@attentionos/core";
import { ApprovalError, decideApproval, enqueueRun, recordAgentEvent, requestApproval, type ApprovalDecision } from "@attentionos/db";
import { kickAdvance, upsertRelease } from "@attentionos/module-production/repo";
import { workspace } from "@/server/workspace";
import { productionOn } from "@/server/queries/production";
import { z } from "zod";
import { BAD_REQUEST, captions as captionsSchema, id as uuid, idOrRef, parse, platforms as platformsSchema } from "@/server/validate";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const ACTOR = "user:studio" as const;
const DECISIONS: ApprovalDecision[] = ["approved", "rejected", "revised"];
const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" };

function explain(e: unknown): string {
  if (e instanceof ApprovalError) return [e.message, e.hint].filter(Boolean).join(" ");
  console.error("[studio] approval decision failed:", e);
  return "Couldn't save that decision. Check the database connection and try again.";
}

type PendingVideo = { id: string; ref: string; subject_type: string; subject_id: string | null; edit_ref: string | null; version: number | null; content_id: string | null; title: string | null };

/** A pending final-video approval and its edit, or null for any other approval. */
async function pendingVideo(idOrRef: string): Promise<PendingVideo | null> {
  const ws = workspace();
  const byId = /^[0-9a-f-]{36}$/i.test(idOrRef);
  const [row] = await ws.sql<PendingVideo[]>`
    select a.id, a.ref, a.subject_type, a.subject_id, e.ref as edit_ref, e.version, e.content_id, c.title
      from approvals a
      left join edit_jobs e on e.id = a.subject_id and e.workspace_id = a.workspace_id
      left join content c on c.id = e.content_id
     where a.workspace_id = ${ws.id} and ${byId ? ws.sql`a.id = ${idOrRef}` : ws.sql`a.ref = ${idOrRef.toLowerCase()}`}
       and a.kind = 'edit' and a.subject_type in ('edit_render', 'edit_job') and a.status = 'pending'`;
  return row?.edit_ref ? row : null;
}

const scheduleInput = z.object({
  releaseId: z.string().max(64),
  input: z.object({ platforms: platformsSchema.optional(), at: z.string().max(64).nullable().optional() }),
});
const decideInput = z.object({ id: idOrRef, decision: z.enum(["approved", "rejected", "revised"]), note: z.string().max(20_000).optional() });
const approveVideoInput = z.object({
  id: idOrRef,
  opts: z.object({ captions: captionsSchema.optional(), platforms: platformsSchema.optional(), then: z.enum(["schedule", "ready"]).optional() }),
});
const videoChangesInput = z.object({
  id: idOrRef,
  input: z.object({
    notes: z.string().max(20_000).optional(),
    timestamps: z.array(z.object({ at: z.union([z.number(), z.nan()]), text: z.string().max(10_000) })).max(500).optional(),
  }),
});

const when = (iso: string, tz: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });

/** What happens after a finished video is approved: schedule it now, or keep it as ready (calendar, download). */
export type AfterApprove = "schedule" | "ready";

/**
 * When a release has posts the Publisher will send itself, the posting plan needs a person's OK unless the Publisher
 * runs on autopilot. The owner's click on Approve or Schedule is that OK: it's recorded as its own decided approval.
 */
async function approvePlan(release: { id: string; slots: { platform: string; scheduledAt: string | null; mode: string }[] }, info: { title: string | null; editRef: string | null; version: number | null; approvedWith: string; plan: string }): Promise<void> {
  const ws = workspace();
  if (agentSettings(ws.config, "publisher").autonomy === "autopilot" || !release.slots.some((s) => s.mode === "auto")) return;
  const planId = randomUUID();
  const { approval } = await requestApproval(ws.sql, ws.id, {
    kind: "campaign",
    subjectType: "week_plan",
    subjectId: planId,
    agent: "publisher",
    summary: `Post “${info.title ?? info.editRef}”: ${info.plan}`,
    preview: { editRef: info.editRef, version: info.version, slots: release.slots, approvedWith: info.approvedWith },
  });
  await decideApproval(ws.sql, ws.id, { refOrId: approval.ref, decision: "approved", actor: ACTOR, note: `Approved together with the video (${info.approvedWith})` });
  await ws.sql`update production_releases set plan_id = ${planId}, updated_at = now() where workspace_id = ${ws.id} and id = ${release.id}`;
}

function describePlan(slots: { platform: string; scheduledAt: string | null; mode: string }[], tz: string): string {
  return slots.map((s) => `${PLATFORM_LABEL[s.platform] ?? s.platform}${s.scheduledAt ? ` ${when(s.scheduledAt, tz)}` : ""}${s.mode === "assist" ? " (you post it)" : ""}`).join(", ");
}

async function enqueueScheduleNow(ref: string, version: number): Promise<void> {
  const ws = workspace();
  await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: "production.schedule-approved",
    agent: "publisher",
    input: { ref, version },
    trigger: "manual",
    createdBy: ACTOR,
    dedupeKey: `production:schedule:${ref}:v${version}:${Date.now().toString(36)}`,
  });
  await kickAdvance(ws, 3);
}

/**
 * Approving a finished video. `then: "schedule"` (the default) also approves the posting plan shown on its card and the
 * Publisher schedules it: `production.schedule-approved` validates each payload and keeps Instagram main feed on assist
 * unless autopost is on. `then: "ready"` keeps it approved but unscheduled: it waits under "Ready to post" on the
 * calendar, where it can be scheduled or downloaded later.
 */
async function approveVideo(v: PendingVideo, opts: { captions?: Record<string, string>; platforms?: string[]; then?: AfterApprove } = {}): Promise<string> {
  const ws = workspace();
  if (!(await productionOn())) {
    await decideApproval(ws.sql, ws.id, { refOrId: v.ref, decision: "approved", actor: ACTOR });
    return `Approved: ${v.ref}`;
  }
  const captions = Object.fromEntries(
    Object.entries(opts.captions ?? {})
      .filter(([p, c]) => p in PLATFORM_LABEL && typeof c === "string" && c.trim())
      .map(([p, c]) => [p, c.trim().slice(0, 5000)]),
  );
  let release = await upsertRelease(ws, { editJobId: v.subject_id!, contentId: v.content_id, version: v.version ?? 1, approvalRef: v.ref, ...(Object.keys(captions).length ? { captions } : {}) });
  if (opts.platforms && release.slots.length) {
    const keep = release.slots.filter((s) => opts.platforms!.includes(s.platform));
    await ws.sql`update production_releases set slots = ${ws.sql.json(keep as never)}, updated_at = now() where workspace_id = ${ws.id} and id = ${release.id}`;
    release = { ...release, slots: keep };
  }
  if (opts.then === "ready") {
    // Mark it ready before the approval lands, so the edit loop never schedules it on its own.
    await ws.sql`update production_releases set status = 'ready', approved_by = ${ACTOR}, approved_at = now(), updated_at = now() where workspace_id = ${ws.id} and id = ${release.id} and status in ('proposed', 'approved')`;
    await decideApproval(ws.sql, ws.id, { refOrId: v.ref, decision: "approved", actor: ACTOR, note: "Approved. Ready to post, not scheduled yet" });
    return "Approved. It's in Calendar under Ready to post: schedule it or download it whenever you like.";
  }
  const plan = describePlan(release.slots, ws.config.workspace.timezone);
  await approvePlan(release, { title: v.title, editRef: v.edit_ref, version: v.version, approvedWith: v.ref, plan });
  await decideApproval(ws.sql, ws.id, { refOrId: v.ref, decision: "approved", actor: ACTOR, note: plan ? `Schedule: ${plan}` : undefined });
  await ws.sql`update production_releases set status = 'approved', approved_by = ${ACTOR}, approved_at = now(), updated_at = now() where workspace_id = ${ws.id} and id = ${release.id} and status = 'proposed'`;
  await enqueueScheduleNow(v.edit_ref!, v.version ?? 1);
  return plan ? `Approved. Scheduling: ${plan}.` : "Approved. The Publisher schedules it next.";
}

/**
 * "Schedule" on a video that's ready to post: the platforms to post on and either a time (every platform at that time)
 * or null for each platform's next open slot. The Publisher then schedules it through Zernio, like an approval would.
 */
export async function scheduleReadyAction(releaseId: string, rawInput: { platforms?: string[]; at?: string | null } = {}): Promise<ActionResult> {
  await requireSession();
  const args = parse(scheduleInput, { releaseId, input: rawInput ?? {} });
  if (!args) return { ok: false, error: BAD_REQUEST };
  const input = args.input;
  if (!/^[0-9a-f-]{36}$/i.test(args.releaseId)) return { ok: false, error: "Unknown video." };
  const ws = workspace();
  const [r] = await ws.sql<{ id: string; status: string; slots: { platform: string; scheduledAt: string | null; mode: "auto" | "assist" }[]; approval_ref: string | null; ref: string; version: number; edit_version: number; title: string | null }[]>`
    select r.id, r.status, r.slots, r.approval_ref, e.ref, r.version, e.version as edit_version, c.title
      from production_releases r join edit_jobs e on e.id = r.edit_job_id left join content c on c.id = r.content_id
     where r.workspace_id = ${ws.id} and r.id = ${releaseId}`;
  if (!r) return { ok: false, error: "Unknown video." };
  if (r.status !== "ready" && r.status !== "failed") return { ok: false, error: r.status === "scheduled" ? "That video is already scheduled." : "That video is already being scheduled." };
  if (r.version !== r.edit_version) return { ok: false, error: "A newer version of this video replaced it." };
  let at: string | null = null;
  if (input.at) {
    const t = Date.parse(input.at);
    if (!Number.isFinite(t)) return { ok: false, error: "Pick a valid date and time." };
    if (t < Date.now() + 10 * 60_000) return { ok: false, error: "Pick a time at least 10 minutes from now." };
    at = new Date(t).toISOString();
  }
  const wanted = Array.isArray(input.platforms) ? input.platforms.filter((p) => typeof p === "string" && p in PLATFORM_LABEL) : r.slots.map((s) => s.platform);
  if (!wanted.length) return { ok: false, error: "Pick at least one platform to post on." };
  const known = new Map(r.slots.map((s) => [s.platform, s]));
  const slots = wanted.map((platform) => ({ platform, scheduledAt: at, mode: known.get(platform)?.mode ?? (platform === "instagram" ? ("assist" as const) : ("auto" as const)) }));
  await ws.sql`update production_releases set slots = ${ws.sql.json(slots as never)}, outcomes = '[]'::jsonb, status = 'approved', updated_at = now() where workspace_id = ${ws.id} and id = ${r.id}`;
  const plan = describePlan(slots, ws.config.workspace.timezone);
  try {
    await approvePlan({ id: r.id, slots }, { title: r.title, editRef: r.ref, version: r.version, approvedWith: r.approval_ref ?? r.ref, plan: plan || "next open slot" });
    await enqueueScheduleNow(r.ref, r.version);
  } catch (e) {
    await ws.sql`update production_releases set status = 'ready', updated_at = now() where workspace_id = ${ws.id} and id = ${r.id}`;
    return { ok: false, error: explain(e) };
  }
  return { ok: true, message: at ? `Scheduling: ${plan}.` : "Scheduling it at the next open slot on each platform." };
}

/**
 * Takes a video off the schedule plan and back to Ready to post (only before the Publisher has scheduled it).
 * Not used yet: no Studio page calls this. Kept for a later release.
 */
export async function unreadyAction(rawReleaseId: string): Promise<ActionResult> {
  await requireSession();
  const releaseId = parse(uuid, rawReleaseId);
  if (!releaseId) return { ok: false, error: "Unknown video." };
  const ws = workspace();
  const rows = await ws.sql`update production_releases set status = 'ready', updated_at = now() where workspace_id = ${ws.id} and id = ${releaseId} and status in ('approved', 'failed') returning id`;
  return rows.length ? { ok: true, message: "Back in Ready to post." } : { ok: false, error: "It's already being scheduled. Cancel the posts from the calendar instead." };
}

/**
 * Records a decision from Studio. `decideApproval` writes the approval, puts a waiting run back on the queue with the
 * decision in its input, and records the agent event every surface sees. Finished videos are scheduled on approval.
 */
export async function decideApprovalAction(rawId: string, rawDecision: ApprovalDecision, rawNote?: string): Promise<ActionResult> {
  await requireSession();
  if (typeof rawId !== "string" || !rawId) return { ok: false, error: "Missing approval." };
  if (!DECISIONS.includes(rawDecision)) return { ok: false, error: "Unknown decision." };
  const args = parse(decideInput, { id: rawId, decision: rawDecision, note: rawNote ?? undefined });
  if (!args) return { ok: false, error: BAD_REQUEST };
  const { id, decision } = args;
  const cleanNote = args.note ? args.note.trim().slice(0, 2000) : "";
  if (decision === "revised" && !cleanNote) return { ok: false, error: "Say what you'd like changed so the agent knows what to fix." };
  const ws = workspace();
  try {
    if (decision === "approved") {
      const video = await pendingVideo(id).catch(() => null);
      if (video) return { ok: true, message: await approveVideo(video) };
    }
    if (decision === "revised") {
      const video = await pendingVideo(id).catch(() => null);
      if (video) return requestVideoChangesAction(id, { notes: cleanNote, timestamps: [] });
    }
    const row = await decideApproval(ws.sql, ws.id, { refOrId: id, decision, actor: ACTOR, ...(cleanNote ? { note: cleanNote } : {}) });
    if (row.kind === "script" && row.subject_type === "script") {
      // The scripting module's decision trigger moves the piece (ready to film, back to ideas, or a rewrite).
      const message =
        decision === "approved" ? "Approved. It's ready to film on Scripts." : decision === "rejected" ? "Rejected. The idea is back on Scripts." : "Sent to the Copywriter with your notes. The new version comes back here.";
      return { ok: true, message };
    }
    const verb = decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Sent back with your notes";
    return { ok: true, message: `${verb}: ${row.ref}` };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

/** Approve a finished video with edited captions and the platforms to post on, then schedule it or keep it ready. */
export async function approveVideoAction(rawId: string, rawOpts: { captions?: Record<string, string>; platforms?: string[]; then?: AfterApprove } = {}): Promise<ActionResult> {
  await requireSession();
  const args = parse(approveVideoInput, { id: rawId, opts: rawOpts ?? {} });
  if (!args) return { ok: false, error: BAD_REQUEST };
  const { id, opts } = args;
  try {
    const video = await pendingVideo(id);
    if (!video) return { ok: false, error: "That video was already decided." };
    const platforms = Array.isArray(opts.platforms) ? opts.platforms.filter((p) => typeof p === "string" && p in PLATFORM_LABEL) : undefined;
    if (platforms && platforms.length === 0) return { ok: false, error: "Pick at least one platform to post on." };
    return { ok: true, message: await approveVideo(video, { captions: opts.captions, ...(platforms ? { platforms } : {}), then: opts.then === "ready" ? "ready" : "schedule" }) };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type TimedNote = { at: number; text: string };

const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Feedback on a finished video: free text plus notes pinned to moments ("at 0:12: cut this pause"). Queues
 * `editing.revise` with the timestamps (times are in the rendered video, the plan's output seconds), then records
 * the decision. Both use the same dedupe key, so exactly one revision runs.
 */
export async function requestVideoChangesAction(rawId: string, rawInput: { notes?: string; timestamps?: TimedNote[] }): Promise<ActionResult> {
  await requireSession();
  const args = parse(videoChangesInput, { id: rawId, input: rawInput ?? {} });
  if (!args) return { ok: false, error: BAD_REQUEST };
  const { id, input } = args;
  const ws = workspace();
  const general = typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : "";
  const timed = (Array.isArray(input.timestamps) ? input.timestamps : [])
    .filter((t) => t && Number.isFinite(t.at) && t.at >= 0 && typeof t.text === "string" && t.text.trim())
    .slice(0, 30)
    .map((t) => ({ at: Math.round(t.at * 100) / 100, text: t.text.trim().slice(0, 300) }))
    .sort((a, b) => a.at - b.at);
  if (!general && !timed.length) return { ok: false, error: "Add a note (or click the timeline to pin one) so the editor knows what to change." };
  const notes = [general, ...timed.map((t) => `At ${stamp(t.at)}: ${t.text}`)].filter(Boolean).join("\n");
  try {
    const video = await pendingVideo(id);
    if (!video) {
      const row = await decideApproval(ws.sql, ws.id, { refOrId: id, decision: "revised", actor: ACTOR, note: notes });
      return { ok: true, message: `Sent back with your notes: ${row.ref}` };
    }
    const fromVersion = video.version ?? 1;
    await enqueueRun(ws.sql, {
      workspaceId: ws.id,
      jobId: "editing.revise",
      agent: "art_director",
      input: { ref: video.edit_ref!, fromVersion, notes, source: { channel: "studio", approval: video.ref, timestamps: timed } },
      trigger: "manual",
      createdBy: ACTOR,
      dedupeKey: `editing:${video.edit_ref}:revise:${video.ref}`,
    });
    await decideApproval(ws.sql, ws.id, { refOrId: video.ref, decision: "revised", actor: ACTOR, note: notes });
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id,
      agent: ACTOR,
      kind: "handoff",
      message: `Asked the Art Director for v${fromVersion + 1} of “${video.title ?? video.edit_ref}”: ${timed.length ? `${timed.length} note${timed.length === 1 ? "" : "s"} on the timeline` : "notes"}${general ? `, “${general.slice(0, 80)}”` : ""}`,
      data: { to: "art_director", ref: video.edit_ref, fromVersion, timestamps: timed },
    });
    if (await productionOn()) await kickAdvance(ws, 2);
    return { ok: true, message: `Sent to the Art Director. Editing v${fromVersion + 1}…` };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

/** Approves every listed item in order. Items someone already decided elsewhere are skipped, not failed. */
export async function approveAllAction(rawIds: string[]): Promise<{ approved: string[]; failed: { id: string; error: string }[] }> {
  await requireSession();
  const ids = parse(z.array(idOrRef).max(1000), rawIds);
  if (!ids) return { approved: [], failed: [{ id: "", error: BAD_REQUEST }] };
  const ws = workspace();
  const approved: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids.slice(0, 100)) {
    try {
      const video = await pendingVideo(id).catch(() => null);
      if (video) await approveVideo(video);
      else await decideApproval(ws.sql, ws.id, { refOrId: id, decision: "approved", actor: ACTOR });
      approved.push(id);
    } catch (e) {
      if (e instanceof ApprovalError && /already/.test(e.message)) continue;
      failed.push({ id, error: explain(e) });
    }
  }
  return { approved, failed };
}

"use server";

import { requireSession } from "@/server/auth";
import { z } from "zod";
import { BAD_REQUEST, id, parse } from "@/server/validate";
import { ApprovalError, decideApproval, enqueueRun, requestApproval } from "@attentionos/db";
import { confirmTrialProof } from "@attentionos/module-publishing/trial-proof";
import { BatchError, createBatch, getBatch, type NewReel } from "@attentionos/module-trial-reels/repo";
import { workspace } from "@/server/workspace";
import { trialBatchView, trialReelsReady, trialSettingsView, trialSourceDefaults, type TrialBatchView, type TrialSettingsView } from "@/server/queries/trial-reels";
import type { TrialSource } from "@attentionos/module-trial-reels/repo";

/**
 * Trial reels from Studio. Making a batch queues the render (`trial-reels.make`); "Schedule N trial reels" is the
 * owner's OK: it is recorded as a decided approval of the batch, then `trial-reels.schedule` sends them as Instagram
 * trial reels only. Cancelling goes through the worker too, so posts already with the publisher come off its schedule.
 */

const ACTOR = "user:studio" as const;
const SUBJECT = "trial_reel_batch";

const sourceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), editRef: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("upload"), assetId: z.string().min(1).max(64) }),
]);
const optionalText = z.string().max(5000).default("");
const makeInput = z.object({
  source: sourceInput,
  title: optionalText,
  otherWordings: z.array(z.string().max(5000)).max(50).default([]),
  captionLine: optionalText,
  hashtags: optionalText,
  layout: z.string().max(32).default("talking-head"),
  endAsk: optionalText,
  date: z.string().max(32).default(""),
  total: z.number(),
});
const cancelInput = z.object({ batchId: z.string().max(64).optional(), postIds: z.array(z.string().max(64)).max(500).optional() });

export type TrialResult<T extends object = object> = ({ ok: true; message?: string } & T) | { ok: false; error: string };

export async function trialFormAction(source: { kind: "edit"; editRef: string } | { kind: "upload"; assetId: string }): Promise<TrialResult<{ settings: TrialSettingsView; source: TrialSource | null }>> {
  await requireSession();
  const src = parse(sourceInput, source);
  if (!src) return { ok: false, error: BAD_REQUEST };
  if (!(await trialReelsReady().catch(() => false))) return { ok: false, error: "Trial reels turn on once publishing is on. Connect Zernio in Settings, then try again." };
  return { ok: true, settings: trialSettingsView(), source: await trialSourceDefaults(src) };
}

export type MakeTrialInput = {
  source: { kind: "edit"; editRef: string } | { kind: "upload"; assetId: string };
  title: string;
  otherWordings: string[];
  captionLine: string;
  hashtags: string;
  layout: "talking-head" | "split-screen";
  endAsk: string;
  date: string;
  total: number;
};

export async function makeTrialReelsAction(input: MakeTrialInput): Promise<TrialResult<{ batchId: string; ref: string }>> {
  await requireSession();
  const parsed = parse(makeInput, input);
  if (!parsed) return { ok: false, error: "Check the form: pick how many to make and fill in each field." };
  input = { ...parsed, layout: parsed.layout === "split-screen" ? "split-screen" : "talking-head" };
  const ws = workspace();
  const reel: NewReel = {
    source: input.source.kind === "edit" ? { kind: "edit", editRef: String(input.source.editRef) } : { kind: "upload", assetId: String(input.source.assetId) },
    titles: [input.title, ...(input.otherWordings ?? [])].map((t) => String(t ?? "").trim()).filter(Boolean).slice(0, 4),
    captionLine: String(input.captionLine ?? "").trim() || null,
    hashtags: String(input.hashtags ?? "").split(/[\s,]+/).filter(Boolean),
    layout: input.layout === "split-screen" ? "split-screen" : "talking-head",
    cta: String(input.endAsk ?? "").trim() ? { text: String(input.endAsk).trim() } : null,
  };
  try {
    const batch = await createBatch(ws, { reels: [reel], date: input.date, total: Number(input.total), createdBy: ACTOR });
    await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: "trial-reels.make", agent: "publisher", input: { batchId: batch.id }, trigger: "manual", createdBy: ACTOR, dedupeKey: `trial-reels:make:${batch.id}` });
    return { ok: true, batchId: batch.id, ref: batch.ref, message: `Making ${batch.total} trial reels for ${batch.post_date}.` };
  } catch (e) {
    if (e instanceof BatchError) return { ok: false, error: [e.message, e.fix].filter(Boolean).join(" ") };
    console.error("[studio] trial reels:", e);
    return { ok: false, error: "Couldn't start the trial reels. Check the database connection and try again." };
  }
}

export async function trialBatchAction(batchId: string): Promise<TrialResult<{ batch: TrialBatchView; settings: TrialSettingsView }>> {
  await requireSession();
  if (!parse(id, batchId) && !parse(z.string().regex(/^tr-\d+$/i), batchId)) return { ok: false, error: "Unknown batch." };
  const batch = await trialBatchView(batchId);
  if (!batch) return { ok: false, error: "That batch is gone." };
  return { ok: true, batch, settings: trialSettingsView() };
}

/** Renders a failed batch again (same inputs). */
export async function retryTrialBatchAction(batchId: string): Promise<TrialResult> {
  await requireSession();
  if (!parse(id, batchId)) return { ok: false, error: "Unknown batch." };
  const ws = workspace();
  const batch = await getBatch(ws, batchId);
  if (!batch) return { ok: false, error: "That batch is gone." };
  if (batch.status !== "failed") return { ok: false, error: "Only a batch that didn't pass can be made again." };
  await ws.sql`update trial_reel_batches set status = 'queued', error = null, progress = null, updated_at = now() where workspace_id = ${ws.id} and id = ${batch.id}`;
  await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: "trial-reels.make", agent: "publisher", input: { batchId: batch.id }, trigger: "manual", createdBy: ACTOR, dedupeKey: `trial-reels:make:${batch.id}:${Date.now()}` });
  return { ok: true, message: "Making them again." };
}

/**
 * "Schedule N trial reels": the owner's OK after seeing the preview. Recorded as a decided approval of the batch
 * (a pending one the Chief of Staff asked for is decided instead, which resumes its run), then the worker sends them.
 */
export async function scheduleTrialReelsAction(batchId: string): Promise<TrialResult> {
  await requireSession();
  if (!parse(id, batchId)) return { ok: false, error: "Unknown batch." };
  const ws = workspace();
  const batch = await getBatch(ws, batchId);
  if (!batch) return { ok: false, error: "That batch is gone." };
  if (!["ready", "proving", "partial"].includes(batch.status)) return { ok: false, error: batch.status === "scheduled" ? "These are already scheduled." : "These trial reels aren't ready to schedule." };
  if (!batch.verify?.ok) return { ok: false, error: "These didn't pass the check, so they can't be scheduled." };
  if (!ws.config.acknowledgements.trialReelsRisk) return { ok: false, error: "Accept the trial reels notice first." };
  try {
    const [latest] = await ws.sql<{ ref: string; status: string; run_id: string | null }[]>`
      select ref, status, run_id from approvals where workspace_id = ${ws.id} and subject_type = ${SUBJECT} and subject_id = ${batch.id} order by requested_at desc limit 1`;
    let resumed = false;
    if (latest?.status === "pending") {
      await decideApproval(ws.sql, ws.id, { refOrId: latest.ref, decision: "approved", actor: ACTOR, note: "Scheduled from Studio after the preview" });
      resumed = Boolean(latest.run_id);
    } else if (latest?.status !== "approved") {
      const names = batch.sources.map((s) => `“${s.name}”`).join(", ");
      const { approval } = await requestApproval(ws.sql, ws.id, {
        kind: "post", subjectType: SUBJECT, subjectId: batch.id, agent: "publisher",
        summary: `Schedule ${batch.total} trial reels of ${names} on ${batch.post_date} (Instagram trial only)`,
        preview: { batch: batch.ref, date: batch.post_date, previewAssetId: batch.preview_asset_id },
      });
      await decideApproval(ws.sql, ws.id, { refOrId: approval.ref, decision: "approved", actor: ACTOR, note: "Scheduled from Studio after the preview" });
    }
    if (!resumed) {
      await enqueueRun(ws.sql, {
        workspaceId: ws.id, jobId: "trial-reels.schedule", agent: "publisher", input: { batchId: batch.id }, trigger: "manual", createdBy: ACTOR,
        dedupeKey: `trial-reels:schedule:${batch.id}:${Math.floor(Date.now() / 30_000)}`,
      });
    }
    await ws.sql`update trial_reel_batches set progress = 'Scheduling', error = null, updated_at = now() where workspace_id = ${ws.id} and id = ${batch.id}`;
    return { ok: true, message: "Scheduling them now." };
  } catch (e) {
    if (e instanceof ApprovalError) return { ok: false, error: [e.message, e.hint].filter(Boolean).join(" ") };
    console.error("[studio] trial reels schedule:", e);
    return { ok: false, error: "Couldn't schedule them. Try again." };
  }
}

/** Cancels a batch's trial reels that aren't live yet (or some posts), through the worker so the publisher drops them too. */
export async function cancelTrialReelsAction(input: { batchId?: string; postIds?: string[] }): Promise<TrialResult> {
  await requireSession();
  const args = parse(cancelInput, input ?? {});
  if (!args) return { ok: false, error: BAD_REQUEST };
  const ws = workspace();
  const postIds = (args.postIds ?? []).filter((p) => parse(id, p)).slice(0, 60);
  const batchId = args.batchId && parse(id, args.batchId) ? args.batchId : undefined;
  if (!batchId && !postIds.length) return { ok: false, error: "Nothing to cancel." };
  if (batchId) {
    const batch = await getBatch(ws, batchId);
    if (!batch) return { ok: false, error: "That batch is gone." };
    if (["queued", "rendering", "ready", "failed"].includes(batch.status)) {
      await ws.sql`update trial_reel_batches set status = 'cancelled', progress = null, updated_at = now() where workspace_id = ${ws.id} and id = ${batch.id}`;
      return { ok: true, message: "Discarded. Nothing was scheduled." };
    }
  }
  await enqueueRun(ws.sql, {
    workspaceId: ws.id, jobId: "trial-reels.cancel", agent: "publisher", input: { ...(batchId ? { batchId } : {}), ...(postIds.length ? { postIds } : {}) },
    trigger: "manual", createdBy: ACTOR, dedupeKey: `trial-reels:cancel:${batchId ?? postIds.join(",")}:${Math.floor(Date.now() / 10_000)}`,
  });
  return { ok: true, message: "Cancelling. They come off your publisher's schedule in a moment." };
}

/** "It stayed off my grid": the owner's one-time check that trial reels work on this account. */
export async function confirmTrialProofAction(postId: string): Promise<TrialResult> {
  await requireSession();
  if (!parse(id, postId)) return { ok: false, error: "Unknown post." };
  const ws = workspace();
  const ctx = { id: ws.id, sql: ws.sql, config: ws.config, now: () => new Date() };
  const res = await confirmTrialProof(ctx as unknown as Parameters<typeof confirmTrialProof>[0], postId, ACTOR);
  return res.ok ? { ok: true, message: res.message } : { ok: false, error: res.message };
}

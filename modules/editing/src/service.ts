import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { agentSettings, compact, moduleSettings, ToolError, type Actor, type JobContext, type Transcript, type WorkspaceContext } from "@attentionos/core";
import { decideApproval, enqueueRun, requestApproval } from "@attentionos/db";
import type { ValidationResult } from "@attentionos/guardrails";
import {
  applyEditMapChanges,
  approveEditMap,
  describeQc,
  draftPlan,
  editMapTimeMap,
  ffprobe,
  formatCutOptions,
  FormatError,
  loadFormat,
  media,
  MediaPyError,
  parseEditMap,
  parseEditPlan,
  planOutputDuration,
  summarizeEditMap,
  TimeMap,
  validateEditPlan,
  type EditMap,
  type EditPlan,
  type FormatTemplate,
  type MediaPyOptions,
  type QcReport,
} from "@attentionos/media";
import { addSignoff, claimLedgerFor, describeIssues, resolvePlanAssets, runGate } from "./gates.ts";
import { notify } from "./notify.ts";
import {
  createEditJob,
  getAsset,
  getEditJob,
  insertAsset,
  latestSessionFor,
  setContentStatus,
  updateEditJob,
  type EditJobRow,
  type EditNote,
  type EditPreflightState,
} from "./repo.ts";
import { planDigests, revisionKind } from "./revisions.ts";
import { editingSettings } from "./settings.ts";

export const JOB_IDS = {
  prep: "editing.prep",
  plan: "editing.plan",
  render: "editing.render",
  revise: "editing.revise",
  transcribe: "editing.transcribe",
} as const;

/** Prep data kept next to the edit map in edit_jobs.edit_map.prep. */
export type PrepState = {
  workDir: string;
  proxy: string | null;
  proxyAssetId: string | null;
  transcriptPath: string;
  transcriptAssetId: string | null;
  audio: string;
  contactSheet: string | null;
  /** Faces and colour statistics from prep's analysis pass (the renderer reads it; optional for older edits). */
  analysis?: string | null;
};

export type ApprovalInput = { ref: string; decision: "approved" | "rejected" | "revised"; note?: string | null };

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------

export function workDir(ws: WorkspaceContext, ref: string): string {
  return join(ws.paths.media, "work", ref);
}

export function renderPath(ws: WorkspaceContext, ref: string, version: number): string {
  return join(ws.paths.media, "renders", ref, `v${version}.mp4`);
}

/** media-py options for a job: cancellation and progress events wired through. */
export function pyOptions(ctx?: Pick<JobContext<unknown>, "signal" | "progress"> | null, extra: MediaPyOptions = {}): MediaPyOptions {
  return {
    ...extra,
    ...(ctx ? { signal: ctx.signal, onProgress: (m: string) => void ctx.progress(m).catch(() => {}) } : {}),
  };
}

async function mustJob(ws: WorkspaceContext, ref: string): Promise<EditJobRow> {
  const job = await getEditJob(ws, ref);
  if (!job) throw new ToolError(`There is no edit called ${ref}.`, "Edit refs look like rf-12; list recent edits with editing_get_edit_job.");
  return job;
}

function state(job: EditJobRow): EditPreflightState {
  return { signoffs: [], ...(job.preflight ?? {}) };
}

function prepOf(job: EditJobRow): PrepState | null {
  const p = (job.edit_map as { prep?: PrepState } | null)?.prep;
  return p ?? null;
}

function editMapOf(job: EditJobRow): EditMap | null {
  return job.edit_map ? parseEditMap(job.edit_map) : null;
}

function readTranscript(path: string): Transcript | null {
  if (!existsSync(path)) return null;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as Transcript;
    return Array.isArray(t.words) ? t : null;
  } catch {
    return null;
  }
}

function loadFormatOr(id: string): FormatTemplate {
  try {
    return loadFormat(id);
  } catch (err) {
    if (err instanceof FormatError) throw new ToolError(err.message, err.fix);
    throw err;
  }
}

/** Plain-language error for anything media-py throws. */
export function mediaProblem(err: unknown): string {
  if (err instanceof MediaPyError) return err.fix ? `${err.message} ${err.fix}` : err.message;
  if (err instanceof ToolError) return err.hint ? `${err.message} ${err.hint}` : err.message;
  return (err as Error)?.message ?? String(err);
}

const fmtS = (s: number) => `${s.toFixed(1)}s`;

function autoApproves(ws: WorkspaceContext): boolean {
  return editingSettings(ws).autoApproveCutList || agentSettings(ws.config, "art_director").autonomy === "autopilot";
}

/**
 * True when the production workflow will approve this cut list on its own a few seconds from now: the edit came from
 * a Studio upload (`production_uploads`, role "edit") and "Review cuts before editing" (`reviewCuts`: module config,
 * overridden live by the `production:settings` row) is off, which is the default. The "cut list ready" message is
 * then skipped, since the owner is never asked. Read straight from the tables so editing doesn't import production.
 */
export async function productionApprovesCuts(ws: WorkspaceContext, editJobId: string): Promise<boolean> {
  const [t] = await ws.sql<{ ok: boolean }[]>`select to_regclass('production_uploads') is not null as ok`;
  if (!t?.ok) return false;
  const [link] = await ws.sql`select 1 from production_uploads where workspace_id = ${ws.id} and edit_job_id = ${editJobId} and role = 'edit' limit 1`;
  if (!link) return false;
  const [live] = await ws.sql<{ value: { reviewCuts?: unknown } | null }[]>`
    select value from settings where workspace_id = ${ws.id} and key = 'production:settings'`;
  const configured = (moduleSettings(ws.config, "production").settings as { reviewCuts?: unknown } | undefined)?.reviewCuts;
  const reviewCuts = typeof live?.value?.reviewCuts === "boolean" ? live.value.reviewCuts : configured === true;
  return !reviewCuts;
}

async function pendingApproval(ws: WorkspaceContext, jobId: string, subjectType: string): Promise<{ id: string; ref: string } | null> {
  const [row] = await ws.sql<{ id: string; ref: string }[]>`
    select id, ref from approvals where workspace_id = ${ws.id} and status = 'pending' and kind = 'edit'
       and subject_type = ${subjectType} and subject_id = ${jobId} order by requested_at desc limit 1`;
  return row ?? null;
}

async function decidedBy(ws: WorkspaceContext, approvalRef: string): Promise<string> {
  const [row] = await ws.sql<{ decided_by: string | null }[]>`select decided_by from approvals where workspace_id = ${ws.id} and ref = ${approvalRef}`;
  return row?.decided_by ?? "user:unknown";
}

function addNote(job: EditJobRow, note: EditNote): EditNote[] {
  const notes = Array.isArray(job.notes) ? job.notes : [];
  const dupe = notes.some((n) => n.text === note.text && n.version === note.version && JSON.stringify(n.source ?? null) === JSON.stringify(note.source ?? null));
  return dupe ? notes : [...notes, note];
}

// ---------------------------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------------------------

export async function startEdit(
  ws: WorkspaceContext,
  actor: Actor,
  input: { path: string; contentId?: string | null; format?: string | null },
): Promise<{ ref: string; editJobId: string; runId: string; format: string; durationS: number; message: string }> {
  const abs = isAbsolute(input.path) ? input.path : resolve(ws.paths.root, input.path);
  if (!existsSync(abs)) throw new ToolError(`There is no file at ${input.path}.`, "Give the full path to the video, or a path inside the workspace (media/raw/...).");
  let probe;
  try {
    probe = await ffprobe(abs);
  } catch (err) {
    throw new ToolError(`Couldn't read ${basename(abs)}: ${mediaProblem(err)}`, "Is it a video file? Phone recordings (.mov, .mp4) work.");
  }
  if (!probe.video) throw new ToolError(`${basename(abs)} has no picture.`, "Use the video file of the take, not an audio export.");
  if (!probe.audio) throw new ToolError(`${basename(abs)} has no sound, so there is nothing to cut on.`, "Use the take with its original audio.");
  let template: string | null = null;
  if (input.contentId) {
    const [c] = await ws.sql<{ template: string | null }[]>`select template from content where workspace_id = ${ws.id} and id = ${input.contentId}`;
    if (!c) throw new ToolError(`There is no content item ${input.contentId}.`);
    template = c.template;
  }
  const format = loadFormatOr(input.format ?? template ?? editingSettings(ws).defaultFormat);
  const asset = await insertAsset(ws, {
    kind: "raw",
    uri: abs,
    contentId: input.contentId ?? null,
    durationS: probe.durationS,
    width: probe.video.displayWidth,
    height: probe.video.displayHeight,
    provenance: { source: "own footage", addedBy: actor, fileName: basename(abs) },
    license: "own footage",
  });
  const job = await createEditJob(ws, { sourceAssetId: asset.id, contentId: input.contentId ?? null, format: format.id });
  await setContentStatus(ws, input.contentId ?? null, "editing", format.id);
  const run = await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: JOB_IDS.prep, agent: "art_director", input: { ref: job.ref }, trigger: "manual", createdBy: actor, dedupeKey: `editing:${job.ref}:prep` });
  return {
    ref: job.ref,
    editJobId: job.id,
    runId: run.id,
    format: format.id,
    durationS: probe.durationS,
    message: `Started ${job.ref}: prepping ${basename(abs)} (${fmtS(probe.durationS)}) as a ${format.name}. The cut list comes back for review next.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// prep (native job body)
// ---------------------------------------------------------------------------------------------------------------

async function transcribeCached(ws: WorkspaceContext, audio: string, cachePath: string, language?: string): Promise<Transcript> {
  const cached = readTranscript(cachePath);
  if (cached) return cached;
  const asr = ws.providers.asr;
  if (!asr) {
    throw new ToolError("Speech-to-text isn't set up, so the footage can't be transcribed.", "Run `attentionos doctor --fix` to install the speech model (Level 2 setup).");
  }
  const t = await asr.transcribe(audio, language ? { language } : {});
  writeFileSync(cachePath, JSON.stringify(t, null, 1));
  return t;
}

export async function runPrep(ctx: JobContext<{ ref: string; approval?: ApprovalInput }>): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const job = await mustJob(ws, ctx.input.ref);
  if (ctx.input.approval) return onCutListDecision(ctx, job, ctx.input.approval);
  if (job.status === "cancelled") return { ref: job.ref, skipped: "cancelled" };
  const settings = editingSettings(ws);
  const format = loadFormatOr(job.format ?? settings.defaultFormat);
  const raw = await getAsset(ws, job.source_asset_id);
  if (!raw || !existsSync(raw.uri)) {
    await updateEditJob(ws, job.id, { status: "failed" });
    throw new ToolError(`The source footage for ${job.ref} is missing.`, "Start the edit again with the file's current path.");
  }
  await updateEditJob(ws, job.id, { status: "prepping" });
  const wd = workDir(ws, job.ref);
  mkdirSync(wd, { recursive: true });
  try {
    await ctx.progress(`Preparing ${basename(raw.uri)} for ${job.ref}`);
    const prepped = await media.prep({ source: raw.uri, workDir: wd, asr: { engine: "none" } }, pyOptions(ctx));
    await ctx.progress("Transcribing the take");
    const transcriptPath = join(wd, "transcript.json");
    const transcript = await transcribeCached(ws, prepped.audio, transcriptPath, settings.asr.language);
    const options = {
      ...formatCutOptions(format),
      ...Object.fromEntries(Object.entries(settings.cut).filter(([, v]) => v !== undefined)),
      ...(settings.editNotePhrases ? { editNotePhrases: settings.editNotePhrases } : {}),
    };
    await ctx.progress("Finding pauses, retakes and spoken edit notes");
    const em = await media.cutPlan(
      { audioPath: prepped.audio, sourcePath: prepped.proxy ?? raw.uri, durationS: prepped.probe.durationS, transcript: { language: transcript.language, words: transcript.words }, options },
      pyOptions(ctx),
    );
    const proxyAsset = prepped.proxy
      ? await insertAsset(ws, { kind: "proxy", uri: prepped.proxy, contentId: job.content_id, durationS: prepped.probe.durationS, provenance: { source: "prep", from: raw.id } })
      : null;
    const tAsset = await insertAsset(ws, { kind: "transcript", uri: transcriptPath, contentId: job.content_id, durationS: transcript.durationS, provenance: { source: "asr", engine: ws.providers.asr?.id ?? "unknown", from: raw.id } });
    const prep: PrepState = {
      workDir: wd,
      proxy: prepped.proxy ?? null,
      proxyAssetId: proxyAsset?.id ?? null,
      transcriptPath,
      transcriptAssetId: tAsset.id,
      audio: prepped.audio,
      contactSheet: prepped.contactSheet ?? null,
      analysis: prepped.analysis ?? null,
    };
    const map = parseEditMap(em);
    const summary = summarizeEditMap(map);
    await updateEditJob(ws, job.id, { edit_map: { ...em, prep }, status: "review" });
    if (autoApproves(ws)) {
      const r = await approveCutList(ws, "agent:art_director", job.ref, {}, { auto: true });
      return { ref: job.ref, status: r.status, summary, autoApproved: true };
    }
    const { approval } = await requestApproval(ws.sql, ws.id, {
      kind: "edit",
      subjectType: "edit_map",
      subjectId: job.id,
      agent: "art_director",
      summary: `${job.ref} cut list: ${summary}`,
      preview: compact({ ref: job.ref, cuts: map.cuts.length, flags: map.flags.map((f) => f.message), estimatedMaxPauseS: map.stats.estimatedMaxPauseS, contactSheet: prep.contactSheet }),
      runId: ctx.runId,
    });
    if (await productionApprovesCuts(ws, job.id)) {
      // Production approves it within seconds; the owner only hears about the finished video.
      return { ref: job.ref, status: "review", summary, approvalRef: approval.ref, notified: false };
    }
    await notify(ws, {
      dedupeKey: `editing:${job.ref}:cutlist:v${job.version}`,
      ref: job.ref,
      text: `${job.ref}: the cut list is ready. ${summary}${map.flags.length ? `\nTo check: ${map.flags.map((f) => f.message).join(" ")}` : ""}\nApprove it to plan the edit, or say which cuts to put back.`,
      actions: [
        { id: `approve:${approval.ref}`, label: "Approve cuts", style: "primary" },
        { id: `reject:${approval.ref}`, label: "Stop", style: "danger" },
      ],
      ...(prep.contactSheet ? { attachments: [{ localPath: prep.contactSheet, caption: `${job.ref} contact sheet` }] } : {}),
    });
    return { ref: job.ref, status: "review", summary, approvalRef: approval.ref };
  } catch (err) {
    await updateEditJob(ws, job.id, { status: "failed" });
    await notify(ws, { dedupeKey: `editing:${job.ref}:prep-failed:${Date.now()}`, ref: job.ref, priority: "high", text: `${job.ref}: prep stopped. ${mediaProblem(err)}` });
    throw err;
  }
}

async function onCutListDecision(ctx: JobContext<{ ref: string }>, job: EditJobRow, a: ApprovalInput): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const by = await decidedBy(ws, a.ref);
  if (a.decision === "approved") {
    const r = await approveCutList(ws, by as Actor, job.ref, {}, { viaApproval: true });
    return { ref: job.ref, status: r.status, decision: "approved" };
  }
  const note: EditNote = { at: ws.now().toISOString(), by, version: job.version, text: a.note ?? (a.decision === "rejected" ? "Stopped at the cut list." : "Changes asked on the cut list."), source: { approval: a.ref } };
  if (a.decision === "rejected") {
    await updateEditJob(ws, job.id, { status: "cancelled", notes: addNote(job, note) });
    await notify(ws, { dedupeKey: `editing:${job.ref}:stopped`, ref: job.ref, text: `${job.ref} stopped. Send a new take whenever you're ready.` });
    return { ref: job.ref, status: "cancelled" };
  }
  await updateEditJob(ws, job.id, { status: "review", notes: addNote(job, note) });
  await notify(ws, {
    dedupeKey: `editing:${job.ref}:cutlist-changes:${a.ref}`,
    ref: job.ref,
    text: `${job.ref}: got it. Tell me which cuts to put back (by number) or which seconds to remove, then approve the cut list.`,
  });
  return { ref: job.ref, status: "review", decision: "revised" };
}

// ---------------------------------------------------------------------------------------------------------------
// cut list review
// ---------------------------------------------------------------------------------------------------------------

export async function approveCutList(
  ws: WorkspaceContext,
  actor: Actor,
  ref: string,
  changes: { restore?: number[]; add?: { start: number; end: number; reason?: string }[]; note?: string },
  opts: { auto?: boolean; viaApproval?: boolean } = {},
): Promise<{ ref: string; status: string; summary: string; planRunId: string }> {
  const job = await mustJob(ws, ref);
  if (!job.edit_map) throw new ToolError(`${job.ref} has no cut list yet.`, "Wait for prep to finish; you'll get a message when it's ready.");
  if (!["review", "planning"].includes(job.status)) {
    throw new ToolError(`${job.ref} is ${job.status}; the cut list can only change while it waits for review.`, "To change a rendered edit, add a revision note instead.");
  }
  if (actor.startsWith("agent:") && !opts.auto) {
    throw new ToolError("Only a person can approve the cut list.", "Ask the owner to approve it (or turn the Art Director to autopilot).");
  }
  const prep = prepOf(job);
  let map = parseEditMap(job.edit_map);
  const changed = (changes.restore?.length ?? 0) + (changes.add?.length ?? 0) > 0;
  if (changed) {
    try {
      map = applyEditMapChanges(map, { restore: (changes.restore ?? []).map((n) => n - 1), add: changes.add ?? [] });
    } catch (err) {
      throw new ToolError((err as Error).message, "Cut numbers start at 1, as shown in the cut list.");
    }
  }
  const already = map.status === "approved" && !changed;
  if (!already) map = approveEditMap(map, actor, ws.now());
  const st = state(job);
  const signoffs = already ? st.signoffs : addSignoff(st.signoffs, "edit_map", actor, ws.now());
  const notes = changes.note ? addNote(job, { at: ws.now().toISOString(), by: actor, version: job.version, text: changes.note }) : job.notes;
  await updateEditJob(ws, job.id, { edit_map: { ...map, prep }, status: "planning", preflight: { ...st, signoffs }, notes });
  if (!opts.viaApproval && actor.startsWith("user:")) {
    const pending = await pendingApproval(ws, job.id, "edit_map");
    if (pending) await decideApproval(ws.sql, ws.id, { refOrId: pending.ref, decision: "approved", actor, note: "Approved from the cut list" });
  }
  const run = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: JOB_IDS.plan,
    agent: "art_director",
    input: { ref: job.ref },
    trigger: "event",
    createdBy: actor,
    dedupeKey: `editing:${job.ref}:plan:v${job.version}:${map.keepRanges.length}:${map.stats.outputS}`,
  });
  return { ref: job.ref, status: "planning", summary: summarizeEditMap(map), planRunId: run.id };
}

// ---------------------------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------------------------

/** Transcript in OUTPUT seconds, one line per phrase: "[0.00–2.31] So here's the thing." (token-cheap). */
export function outputTranscriptLines(words: Transcript["words"], tm: TimeMap): string[] {
  const mapped = tm.mapWords(words);
  const lines: string[] = [];
  let cur: typeof mapped = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push(`[${cur[0]!.start.toFixed(2)}–${cur[cur.length - 1]!.end.toFixed(2)}] ${cur.map((w) => w.text).join(" ")}`);
    cur = [];
  };
  for (const w of mapped) {
    if (cur.length && w.start - cur[cur.length - 1]!.end > 0.5) flush();
    cur.push(w);
    if (/[.?!]["')\]]*$/.test(w.text) || cur.length >= 14) flush();
  }
  flush();
  return lines;
}

function sourceFor(job: EditJobRow, map: EditMap, raw: { id: string; uri: string } | null, prep: PrepState | null) {
  return { path: prep?.proxy ?? raw?.uri ?? map.source.path, durationS: map.source.durationS, ...(raw ? { assetId: raw.id } : {}) };
}

export async function getPlanContext(ws: WorkspaceContext, ref: string): Promise<Record<string, unknown>> {
  const job = await mustJob(ws, ref);
  const map = editMapOf(job);
  if (!map) throw new ToolError(`${job.ref} has no cut list yet.`, "Prep runs first; try again when it's done.");
  if (map.status !== "approved") throw new ToolError(`${job.ref}'s cut list hasn't been approved yet.`, "The owner approves the cuts before the plan is written.");
  const format = loadFormatOr(job.format ?? editingSettings(ws).defaultFormat);
  const prep = prepOf(job);
  const raw = await getAsset(ws, job.source_asset_id);
  const transcript = (prep && readTranscript(prep.transcriptPath)) ?? { language: "en", text: "", words: [], durationS: 0 };
  const plan: EditPlan | null = job.plan ? parseEditPlan(job.plan) : null;
  const draft = plan ?? parseEditPlan(draftPlan({ format, editMap: map, transcript, source: sourceFor(job, map, raw, prep), houseStyle: "brand/house-style.md" }));
  const tm = TimeMap.fromKeepRanges(draft.source.timeMap.keepRanges, draft.source.timeMap.fps, draft.source.media.durationS);
  const ledger = await claimLedgerFor(ws, job.content_id);
  const assets = await ws.sql<{ id: string; kind: string; uri: string; license: string | null; provenance: unknown; duration_s: string | null }[]>`
    select id, kind, uri, license, provenance, duration_s from media_assets
     where workspace_id = ${ws.id} and kind in ('broll', 'image', 'screenshot', 'logo', 'music', 'sfx')
       and (${job.content_id}::uuid is null or content_id = ${job.content_id})
     order by created_at desc limit 40`;
  const { source: _source, ...planBody } = draft;
  return compact({
    ref: job.ref,
    version: job.version,
    status: job.status,
    outputDurationS: Number(tm.outputDurationS.toFixed(3)),
    format: {
      id: format.id,
      name: format.name,
      summary: format.summary,
      layout: format.layout,
      captions: format.captions,
      overlaySlots: format.overlaySlots,
      pacing: { targetLengthS: format.pacing.targetLengthS, hookBy: format.pacing.hookBy, notes: format.pacing.notes },
      audio: format.audio,
      camera: format.camera,
      broll: format.broll,
    },
    transcript: outputTranscriptLines(transcript.words, tm),
    keepRanges: draft.source.timeMap.keepRanges,
    plan: planBody,
    isDraft: plan === null,
    claims: ledger.filter((c) => c.verdict === "PASS" && c.id).map((c) => ({ id: c.id, claim: c.claim })),
    assets: assets.map((a) => ({ id: a.id, kind: a.kind, file: basename(a.uri), license: a.license, durationS: a.duration_s ? Number(a.duration_s) : undefined })),
    houseStyle: "brand/house-style.md",
    lessons: "brand/lessons.md",
    notes: (job.notes ?? []).slice(-5),
    lastPlanCheck: state(job).plan?.errors?.length ? state(job).plan?.errors : undefined,
  });
}

export async function savePlan(
  ws: WorkspaceContext,
  actor: Actor,
  ref: string,
  body: Record<string, unknown>,
): Promise<{ ref: string; version: number; saved: true; outputDurationS: number; warnings: string[] }> {
  const job = await mustJob(ws, ref);
  const map = editMapOf(job);
  if (!map || map.status !== "approved") throw new ToolError(`${job.ref}'s cut list hasn't been approved yet.`, "The owner approves the cuts before a plan can be saved.");
  if (["cancelled", "rendering", "qc"].includes(job.status)) throw new ToolError(`${job.ref} is ${job.status}; wait for it to finish before saving a new plan.`);
  const prep = prepOf(job);
  const raw = await getAsset(ws, job.source_asset_id);
  const transcript = (prep && readTranscript(prep.transcriptPath)) ?? { language: "en", text: "", words: [], durationS: 0 };
  const srcBody = (body.source ?? {}) as { timeMap?: { keepRanges?: unknown } };
  const keepRanges = body.keepRanges ?? srcBody.timeMap?.keepRanges ?? map.keepRanges;
  const { keepRanges: _k, source: _s, ...rest } = body;
  const full = {
    ...rest,
    version: 1,
    format: (rest.format as string | undefined) ?? job.format,
    source: {
      media: sourceFor(job, map, raw, prep),
      transcript: { language: transcript.language, words: transcript.words },
      timeMap: { fps: map.fps, keepRanges, dropped: map.cuts.map((c) => ({ start: c.start, end: c.end, reason: c.reason, kind: c.kind })), protected: map.protected },
    },
    meta: { ...((rest.meta as object) ?? {}), houseStyle: "brand/house-style.md" },
  };
  const v = validateEditPlan(full);
  if (!v.ok) {
    throw new ToolError(`The plan has ${v.issues.length} problem${v.issues.length === 1 ? "" : "s"}:\n${v.issues.slice(0, 12).map((i) => `- ${i.path}: ${i.message}`).join("\n")}`, "Fix exactly these and save again.");
  }
  const plan = v.plan;
  const format = loadFormatOr(plan.format);
  const { assets, problems } = await resolvePlanAssets(ws, plan);
  if (problems.length) throw new ToolError(`Some media in the plan can't be used:\n${problems.map((p) => `- ${p}`).join("\n")}`, "Use asset ids from editing_get_plan.");
  const ledger = await claimLedgerFor(ws, job.content_id);
  const st = state(job);
  const gate = runGate({ ws, stage: "plan", plan, format, assets, claimLedger: ledger, signoffs: st.signoffs });
  if (!gate.ok) {
    await updateEditJob(ws, job.id, { preflight: { ...st, plan: gate } });
    throw new ToolError(`The plan didn't pass the plan check:\n${describeIssues(gate)}`, "Fix the listed issues and save again.");
  }
  const rendered = job.output_asset_id !== null || ["review", "approved"].includes(job.status);
  const version = rendered ? job.version + 1 : job.version;
  plan.meta = { ...plan.meta, revision: version };
  await updateEditJob(ws, job.id, {
    plan,
    version,
    status: "planning",
    output_asset_id: rendered ? null : job.output_asset_id,
    preflight: { ...st, signoffs: addSignoff(st.signoffs, "plan", actor, ws.now()), plan: gate },
  });
  return { ref: job.ref, version, saved: true, outputDurationS: Number(planOutputDuration(plan).toFixed(3)), warnings: gate.warnings.map((w) => w.message) };
}

export async function requestRender(ws: WorkspaceContext, actor: Actor, ref: string, opts: { auto?: boolean } = {}): Promise<{ ref: string; version: number; runId: string; queued: boolean }> {
  const job = await mustJob(ws, ref);
  if (!job.plan) throw new ToolError(`${job.ref} has no saved plan.`, "Save one with editing_save_plan first.");
  if (!state(job).plan?.ok) throw new ToolError(`${job.ref}'s plan hasn't passed the plan check.`, "Save the plan again and fix what it reports.");
  if (["rendering", "qc"].includes(job.status)) throw new ToolError(`${job.ref} v${job.version} is already rendering.`);
  const d = planDigests(parseEditPlan(job.plan));
  await updateEditJob(ws, job.id, { status: "rendering" });
  const run = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: JOB_IDS.render,
    agent: "art_director",
    input: { ref: job.ref, version: job.version },
    trigger: "event",
    createdBy: actor,
    ...(opts.auto ? { dedupeKey: `editing:${job.ref}:render:v${job.version}:${d.videoDigest.slice(0, 10)}${d.audioDigest.slice(0, 6)}` } : {}),
  });
  return { ref: job.ref, version: job.version, runId: run.id, queued: !run.deduped };
}

// ---------------------------------------------------------------------------------------------------------------
// clean render: the approved edit without captions or on-screen text (for trial reels)
// ---------------------------------------------------------------------------------------------------------------

/** Overlay kinds that are words on screen. A clean render leaves them out; pictures (screenshots, charts) stay. */
const TEXT_OVERLAYS = new Set(["headline", "lower-third"]);

/** The edit plan with captions off and every text overlay removed. Cuts, framing, look, B-roll and audio are kept. */
export function cleanPlan(plan: EditPlan): EditPlan {
  return { ...plan, captions: { ...plan.captions, style: "none", emphasisWords: [] }, overlays: plan.overlays.filter((o) => !TEXT_OVERLAYS.has(o.kind)) };
}

export function cleanRenderPath(ws: WorkspaceContext, ref: string, version: number): string {
  // Not under media/renders/<ref>/: those files are the versions the owner reviews.
  return join(ws.paths.media, "renders-clean", ref, `v${version}.mp4`);
}

export type CleanRender = { ref: string; version: number; path: string; assetId: string; durationS: number; contentId: string | null; reused: boolean };

/**
 * A clean render of an edit's current version: the same cuts, framing, audio and colour as the finished video, with
 * no captions and no title or other text on screen. Trial reels draw their own captions and titles on top of it.
 * Rendered once per edit version (kept as a media asset of kind `other`, provenance `clean-render`) and reused.
 */
export async function renderClean(
  ws: WorkspaceContext,
  ref: string,
  opts: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
): Promise<CleanRender> {
  const job = await mustJob(ws, ref);
  if (!job.plan) throw new ToolError(`${job.ref} has no edit plan yet, so there is nothing to render clean.`, "Finish the edit first.");
  if (!["review", "approved"].includes(job.status)) throw new ToolError(`${job.ref} isn't finished yet (${job.status}).`, "Make trial reels from a finished or approved video.");
  const version = job.version;
  const path = cleanRenderPath(ws, job.ref, version);
  const [existing] = await ws.sql<{ id: string; uri: string; duration_s: string | null }[]>`
    select id, uri, duration_s::text from media_assets
     where workspace_id = ${ws.id} and kind = 'other' and provenance->>'source' = 'clean-render'
       and provenance->>'edit' = ${job.ref} and provenance->>'editVersion' = ${String(version)}
     order by created_at desc limit 1`;
  if (existing && existsSync(existing.uri)) {
    return { ref: job.ref, version, path: existing.uri, assetId: existing.id, durationS: Number(existing.duration_s ?? 0), contentId: job.content_id, reused: true };
  }
  const plan = cleanPlan(parseEditPlan(job.plan));
  const { assets, problems } = await resolvePlanAssets(ws, plan);
  if (problems.length) throw new ToolError(`Can't render ${job.ref} clean: ${problems.slice(0, 3).join(" ")}`);
  const wd = workDir(ws, job.ref);
  mkdirSync(join(ws.paths.media, "renders-clean", job.ref), { recursive: true });
  const D = planOutputDuration(plan);
  const py: MediaPyOptions = { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) };
  opts.onProgress?.(`Rendering ${job.ref} v${version} without captions or titles`);
  const r = await media.render(
    { plan, assets, output: join(wd, "out", `v${version}-clean.mp4`), workDir: join(wd, "render"), preset: editingSettings(ws).renderPreset },
    { ...py, timeoutMs: Math.max(5 * 60_000, D * 20_000) },
  );
  await media.finish({ input: r.output, output: path, loudness: plan.audio.loudness, truePeak: plan.audio.truePeak }, py);
  const probe = await ffprobe(path);
  const asset = await insertAsset(ws, {
    kind: "other",
    uri: path,
    durationS: probe.durationS,
    width: probe.video?.displayWidth ?? null,
    height: probe.video?.displayHeight ?? null,
    provenance: { source: "clean-render", edit: job.ref, editVersion: String(version), contentId: job.content_id },
    license: "own footage",
    hash: true,
  });
  return { ref: job.ref, version, path, assetId: asset.id, durationS: probe.durationS, contentId: job.content_id, reused: false };
}

// ---------------------------------------------------------------------------------------------------------------
// render → finish → qc → final gate → output asset → approval (native job body)
// ---------------------------------------------------------------------------------------------------------------

export async function runRender(ctx: JobContext<{ ref: string; version?: number; approval?: ApprovalInput }>): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const job = await mustJob(ws, ctx.input.ref);
  if (ctx.input.approval) return onFinalDecision(ctx, job, ctx.input.approval);
  if (!job.plan) throw new ToolError(`${job.ref} has no plan to render.`);
  if (ctx.input.version && ctx.input.version !== job.version) return { ref: job.ref, skipped: `v${ctx.input.version} was replaced by v${job.version}` };
  const settings = editingSettings(ws);
  const plan = parseEditPlan(job.plan);
  const format = loadFormatOr(plan.format);
  const st = state(job);
  const version = job.version;
  await updateEditJob(ws, job.id, { status: "rendering" });
  try {
    const { assets, problems } = await resolvePlanAssets(ws, plan);
    const ledger = await claimLedgerFor(ws, job.content_id);
    const gate = runGate({ ws, stage: "render", plan, format, assets, claimLedger: ledger, signoffs: st.signoffs, required: ["edit_map", "plan"] });
    if (problems.length || !gate.ok) {
      await updateEditJob(ws, job.id, { status: "planning", preflight: { ...st, render: gate } });
      const why = [...problems, ...gate.errors.map((e) => e.message)].slice(0, 4).join(" ");
      await notify(ws, { dedupeKey: `editing:${job.ref}:v${version}:render-blocked`, ref: job.ref, text: `${job.ref} v${version} can't render yet: ${why}` });
      return { ref: job.ref, version, rendered: false, problems, preflight: gate };
    }
    const prev = st.renders?.[st.renders.length - 1] ?? null;
    const digests = planDigests(plan);
    const kind = revisionKind(prev, digests);
    const wd = workDir(ws, job.ref);
    const finalPath = renderPath(ws, job.ref, version);
    mkdirSync(join(ws.paths.media, "renders", job.ref), { recursive: true });
    const D = planOutputDuration(plan);
    await ctx.progress(`Rendering ${job.ref} v${version} (${fmtS(D)})`);
    const r = await media.render(
      { plan, assets, output: join(wd, "out", `v${version}.mp4`), workDir: join(wd, "render"), preset: settings.renderPreset },
      pyOptions(ctx, { timeoutMs: Math.max(5 * 60_000, D * 20_000) }),
    );
    await ctx.progress("Finishing loudness (-14 LUFS)");
    const fin = await media.finish({ input: r.output, output: finalPath, loudness: plan.audio.loudness, truePeak: plan.audio.truePeak }, pyOptions(ctx));
    await updateEditJob(ws, job.id, { status: "qc" });
    await ctx.progress("Checking the export");
    const qc: QcReport = await media.qc(
      {
        path: finalPath,
        manifest: r.manifest,
        speechStem: r.speechStem,
        expect: { w: plan.export.w, h: plan.export.h, fps: plan.export.fps, durationS: r.durationS },
        loudness: { target: plan.audio.loudness, truePeakMax: plan.audio.truePeak },
        pauses: { maxS: format.pacing.maxPauseS, p90TargetS: format.pacing.p90PauseS },
        ...(prev && kind === "audio_only" && existsSync(prev.output) ? { previous: { path: prev.output, revision: "audio_only" as const } } : {}),
      },
      pyOptions(ctx),
    );
    const probe = await ffprobe(finalPath);
    const finalGate = runGate({
      ws,
      stage: "final",
      plan,
      format,
      assets,
      claimLedger: ledger,
      signoffs: st.signoffs,
      required: ["edit_map", "plan"],
      exportPath: finalPath,
      exportProbe: { width: probe.video?.displayWidth ?? 0, height: probe.video?.displayHeight ?? 0, fps: probe.video?.fps ?? 0, durationS: probe.durationS },
    });
    const out = await insertAsset(ws, {
      kind: "render",
      uri: finalPath,
      contentId: job.content_id,
      durationS: probe.durationS,
      width: probe.video?.displayWidth ?? null,
      height: probe.video?.displayHeight ?? null,
      provenance: { source: "render", renderer: "cut", ref: job.ref, version, planDigest: `${digests.videoDigest}:${digests.audioDigest}` },
      license: "own footage",
      hash: true,
    });
    const session = await latestSessionFor(ws, job.ref);
    const renders = [...(st.renders ?? []), { version, output: finalPath, ...digests, at: ws.now().toISOString(), qcPassed: qc.passed }];
    await updateEditJob(ws, job.id, {
      status: "review",
      qc_report: {
        ...qc,
        render: { reusedChunks: r.reusedChunks, chunks: r.chunks.length, warnings: r.warnings, elapsedS: r.elapsedS, revision: kind, ...(r.encoder ? { encoder: r.encoder } : {}), ...(fin.method ? { finish: fin.method } : {}) },
        loudness: fin.after,
      },
      output_asset_id: out.id,
      session_id: session.sessionId ?? job.session_id,
      cost_micro: session.costMicro,
      preflight: { ...st, render: gate, final: finalGate, renders },
    });
    await setContentStatus(ws, job.content_id, "review");
    const qcLine = describeQc(qc);
    const gateLine = finalGate.ok ? "" : ` Preflight: ${finalGate.errors.map((e) => e.message).slice(0, 2).join(" ")}`;
    const summary = `${job.ref} v${version} is ready: ${fmtS(probe.durationS)} ${format.name}. ${qcLine}${gateLine}`;
    const { approval } = await requestApproval(ws.sql, ws.id, {
      kind: "edit",
      subjectType: "edit_render",
      subjectId: job.id,
      agent: "art_director",
      summary,
      preview: compact({ ref: job.ref, version, path: finalPath, durationS: probe.durationS, qcPassed: qc.passed, problems: qc.checks.filter((c) => c.status === "fail").map((c) => c.detail), reusedParts: r.reusedChunks }),
      runId: ctx.runId,
    });
    await notify(ws, {
      dedupeKey: `editing:${job.ref}:v${version}:ready:${digests.videoDigest.slice(0, 8)}${digests.audioDigest.slice(0, 8)}`,
      ref: `${job.ref} v${version}`,
      text: `${summary}\nReply "${job.ref} v${version + 1} <notes>" to change it, or approve it to schedule.`,
      attachments: [{ localPath: finalPath, caption: `${job.ref} v${version}` }],
      actions: [
        { id: `approve:${approval.ref}`, label: "Approve", style: "primary" },
        { id: `reject:${approval.ref}`, label: "Reject", style: "danger" },
      ],
    });
    return { ref: job.ref, version, output: finalPath, durationS: probe.durationS, qc: { passed: qc.passed, summary: qc.summary }, approvalRef: approval.ref, reusedParts: r.reusedChunks, revision: kind };
  } catch (err) {
    await updateEditJob(ws, job.id, { status: "failed" });
    await notify(ws, { dedupeKey: `editing:${job.ref}:v${version}:failed:${Date.now()}`, ref: job.ref, priority: "high", text: `${job.ref} v${version} didn't render. ${mediaProblem(err)}` });
    throw err;
  }
}

async function onFinalDecision(ctx: JobContext<{ ref: string }>, job: EditJobRow, a: ApprovalInput): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const by = await decidedBy(ws, a.ref);
  const st = state(job);
  if (a.decision === "approved") {
    let signoffs = addSignoff(st.signoffs, "playback", by, ws.now());
    signoffs = addSignoff(signoffs, "claims", by, ws.now());
    await updateEditJob(ws, job.id, { status: "approved", preflight: { ...st, signoffs } });
    await notify(ws, { dedupeKey: `editing:${job.ref}:v${job.version}:approved`, ref: job.ref, text: `${job.ref} v${job.version} approved. It's ready to schedule.` });
    return { ref: job.ref, version: job.version, status: "approved" };
  }
  const note: EditNote = { at: ws.now().toISOString(), by, version: job.version, text: a.note ?? "", source: { approval: a.ref } };
  if (a.decision === "rejected") {
    await updateEditJob(ws, job.id, { status: "cancelled", notes: addNote(job, note) });
    return { ref: job.ref, version: job.version, status: "cancelled" };
  }
  await updateEditJob(ws, job.id, { notes: addNote(job, note) });
  const run = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: JOB_IDS.revise,
    agent: "art_director",
    input: { ref: job.ref, fromVersion: job.version, notes: a.note || "Make it better.", source: { channel: "approval", approval: a.ref } },
    trigger: "event",
    createdBy: by,
    dedupeKey: `editing:${job.ref}:revise:${a.ref}`,
  });
  return { ref: job.ref, version: job.version, status: "revising", reviseRunId: run.id };
}

// ---------------------------------------------------------------------------------------------------------------
// revisions
// ---------------------------------------------------------------------------------------------------------------

export async function addRevisionNote(ws: WorkspaceContext, actor: Actor, ref: string, note: string, fromVersion?: number): Promise<{ ref: string; fromVersion: number; nextVersion: number; queued: boolean }> {
  const job = await mustJob(ws, ref);
  if (!job.output_asset_id && !["review", "approved"].includes(job.status)) {
    throw new ToolError(`${job.ref} hasn't been rendered yet, so there is nothing to revise.`, "For the cut list, use editing_approve_cut_list with the cuts to restore or add.");
  }
  const from = fromVersion ?? job.version;
  const pending = await pendingApproval(ws, job.id, "edit_render");
  if (pending && actor.startsWith("user:")) {
    // Deciding "revised" re-queues the render run, which queues the revision (one path, no duplicates).
    await decideApproval(ws.sql, ws.id, { refOrId: pending.ref, decision: "revised", actor, note });
    return { ref: job.ref, fromVersion: from, nextVersion: job.version + 1, queued: true };
  }
  const run = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: JOB_IDS.revise,
    agent: "art_director",
    input: { ref: job.ref, fromVersion: from, notes: note, source: { channel: "mcp", by: actor } },
    trigger: "manual",
    createdBy: actor,
  });
  return { ref: job.ref, fromVersion: from, nextVersion: job.version + 1, queued: !run.deduped };
}

/** Records the revision note on the edit (idempotent); called when the revise job starts. */
export async function recordRevisionNote(ws: WorkspaceContext, input: { ref: string; fromVersion: number; notes: string; source?: unknown }, by: string): Promise<EditJobRow> {
  const job = await mustJob(ws, input.ref);
  const notes = addNote(job, { at: ws.now().toISOString(), by, version: input.fromVersion, text: input.notes, ...(input.source ? { source: input.source as Record<string, unknown> } : {}) });
  if (notes.length === (job.notes ?? []).length) return job;
  return updateEditJob(ws, job.id, { notes });
}

/**
 * The agent session to resume for a revision ("resume the same agent session"). The runner supports
 * `resumeSessionId`; the worker should pass this value when it runs `editing.revise`.
 */
export async function revisionSessionId(ws: WorkspaceContext, input: { ref: string }): Promise<string | undefined> {
  const job = await getEditJob(ws, input.ref);
  if (job?.session_id) return job.session_id;
  return (await latestSessionFor(ws, input.ref)).sessionId ?? undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// read views
// ---------------------------------------------------------------------------------------------------------------

export async function getEditJobView(ws: WorkspaceContext, ref: string): Promise<Record<string, unknown>> {
  const job = await mustJob(ws, ref);
  const map = editMapOf(job);
  const st = state(job);
  const output = await getAsset(ws, job.output_asset_id);
  const pending = await ws.sql<{ ref: string; subject_type: string; summary: string }[]>`
    select ref, subject_type, summary from approvals where workspace_id = ${ws.id} and status = 'pending' and subject_id = ${job.id}`;
  const qc = job.qc_report as QcReport | null;
  return compact({
    ref: job.ref,
    status: job.status,
    version: job.version,
    format: job.format,
    contentId: job.content_id,
    cutList: map
      ? {
          status: map.status,
          summary: summarizeEditMap(map),
          cuts: map.cuts.map((c, i) => ({ n: i + 1, start: c.start, end: c.end, kind: c.kind, reason: c.reason })),
          flags: map.flags,
          outputS: map.stats.outputS,
          estimatedMaxPauseS: map.stats.estimatedMaxPauseS,
          contactSheet: prepOf(job)?.contactSheet,
        }
      : undefined,
    hasPlan: job.plan !== null,
    planCheck: st.plan ? { ok: st.plan.ok, errors: st.plan.errors.map((e) => e.message) } : undefined,
    output: output ? { path: output.uri, durationS: output.duration_s ? Number(output.duration_s) : undefined } : undefined,
    qc: qc ? { passed: qc.passed, summary: qc.summary } : undefined,
    signoffs: st.signoffs.map((s) => s.kind),
    waitingFor: pending.map((p) => ({ approval: p.ref, what: p.subject_type === "edit_map" ? "cut list" : "final video", summary: p.summary })),
    notes: (job.notes ?? []).slice(-5),
    costUsd: Number(job.cost_micro) / 1e6,
  });
}

export async function getQcReport(ws: WorkspaceContext, ref: string): Promise<Record<string, unknown>> {
  const job = await mustJob(ws, ref);
  const qc = job.qc_report as (QcReport & { render?: unknown; loudness?: unknown }) | null;
  if (!qc) throw new ToolError(`${job.ref} has no QC report yet.`, "QC runs right after the render.");
  const st = state(job);
  return compact({
    ref: job.ref,
    version: job.version,
    passed: qc.passed,
    summary: qc.summary,
    problems: qc.checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => ({ check: c.label, status: c.status, detail: c.detail, fix: c.fix })),
    passedChecks: qc.checks.filter((c) => c.status === "pass").map((c) => c.label),
    loudness: qc.loudness,
    render: qc.render,
    preflight: st.final ? { ok: st.final.ok, errors: st.final.errors.map((e) => e.message), warnings: st.final.warnings.map((w) => w.message) } : undefined,
  });
}

export function relativeToWorkspace(ws: WorkspaceContext, p: string): string {
  const rel = relative(ws.paths.root, p);
  return rel.startsWith("..") ? p : rel;
}

export type { ValidationResult };

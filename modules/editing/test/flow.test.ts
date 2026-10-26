/**
 * End-to-end editing flow on a real Postgres (own database: attentionos_test_editing) with synthetic footage and a
 * stub ASR provider (fixed word timings): start → prep → cut list review → plan (validated + preflight) → render →
 * finish → QC → approval → revision (audio-only, byte-stable picture) → final approval. Plus the research
 * transcription hand-off. Skips when Postgres, uv or ffmpeg are missing.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, silentLogger, ToolError, type Asr, type JobContext, type Sql, type Transcript, type WorkspaceContext } from "@attentionos/core";
import { decideApproval, enqueueRun } from "@attentionos/db";
import { createTestDatabase, hasTestDatabase } from "@attentionos/db/testing";
import { checkMediaTools, ffprobe, mediaPy } from "@attentionos/media";
import { ingestTranscriptInputSchema } from "@attentionos/module-research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addRevisionNote, approveCutList, getEditJob, getEditJobView, getPlanContext, getQcReport, requestRender, runPrep, runRender, runTranscribe, savePlan, startEdit,
} from "../src/index.ts";

const haveTools = checkMediaTools().every((t) => t.ok);
let db: { sql: Sql; drop(): Promise<void> } | null = null;
let ws: WorkspaceContext;
let root: string;
let clip: { path: string; durationS: number; words: { text: string; start: number; end: number }[] };

const say = (s: string, dur = 0.27) => s.split(" ").map((word) => ({ word, dur }));
const SCRIPT = [
  ...say("here is the one setup step most teams skip."), { pause: 0.8 },
  ...say("we tried it on a real project"), { pause: 0.5 }, ...say("cut that."), { pause: 0.6 },
  ...say("we measured it on three real projects last month."), { pause: 0.9 },
  ...say("the first week felt slower than usual."), { pause: 0.7 },
  ...say("by week three every change was written down."), { pause: 0.8 },
  ...say("comparing weekly totals showed which habit moved the needle."), { pause: 0.7 },
  ...say("start small and keep the one habit that works."), { pause: 0.6 },
];

function stubAsr(): Asr {
  return {
    id: "stub",
    async health() {
      return { ok: true, detail: "fixed words" };
    },
    async transcribe(): Promise<Transcript> {
      return { language: "en", text: clip.words.map((w) => w.text).join(" "), words: clip.words, durationS: clip.durationS };
    },
  };
}

/** What the runner does when a native job ends with a pending approval: the run waits for the decision. */
async function endAsRunner(runId: string): Promise<void> {
  await ws.sql`update agent_runs set status = case when exists (select 1 from approvals where run_id = ${runId} and status = 'pending') then 'waiting_approval' else 'succeeded' end where id = ${runId}`;
}

async function ctxFor<I>(jobId: string, input: I, actor = "system" as const): Promise<JobContext<I>> {
  const run = await enqueueRun(ws.sql, { workspaceId: ws.id, jobId, agent: "art_director", input: input as Record<string, unknown>, startRunningAs: "test" });
  return { ws, input, actor, runId: run.id, log: silentLogger, signal: new AbortController().signal, progress: async () => {} };
}

/** Set up at import time (top-level await) so `it.runIf` sees whether Postgres, uv and ffmpeg are available. */
async function setUp(): Promise<{ sql: Sql; drop(): Promise<void> } | null> {
  if (!haveTools) {
    console.warn("[skip] editing flow skipped: uv or ffmpeg is missing (see checkMediaTools).");
    return null;
  }
  // Skip (or, under CI, fail) only when Postgres is unreachable; any other setup error fails the file.
  if (!(await hasTestDatabase())) return null;
  const d = await createTestDatabase("attentionos_test_editing");
  root = mkdtempSync(join(tmpdir(), "aos-editing-"));
  mkdirSync(join(root, "media", "raw"), { recursive: true });
  clip = await mediaPy("synth", { output: join(root, "media", "raw", "take1.mp4"), script: SCRIPT, leadS: 0.7, tailS: 1.2, width: 1080, height: 1920 });
  const [w] = await d.sql<{ id: string }[]>`insert into workspaces (name, slug) values ('Demo editing', 'demo-editing') returning id`;
  const config = parseConfig({ providers: { notifier: "console" } });
  ws = {
    id: w!.id,
    paths: { root, brand: join(root, "brand"), config: join(root, "config/attentionos.config.ts"), media: join(root, "media"), lessons: join(root, "brand/lessons.md"), state: join(root, ".attentionos") },
    config,
    brand: () => { throw new Error("no brand kit in this test"); },
    reloadBrand: () => { throw new Error("no brand kit in this test"); },
    sql: d.sql,
    providers: { trendSources: {}, asr: stubAsr() },
    log: silentLogger,
    now: () => new Date("2026-10-15T12:00:00Z"),
    secret: () => undefined,
  };
  return d;
}
db = await setUp();

afterAll(async () => {
  await db?.drop();
  if (root) rmSync(root, { recursive: true, force: true });
});

const live = haveTools && db !== null;

describe(`editing flow${live ? "" : " (needs Postgres, uv and ffmpeg)"}`, () => {
  let ref = "";

  it.runIf(live)("starts an edit, preps it and asks for cut-list review", { timeout: 120_000 }, async () => {
    const started = await startEdit(ws, "user:owner", { path: "media/raw/take1.mp4", format: "raw-talking-head" });
    ref = started.ref;
    expect(ref).toMatch(/^rf-\d+$/);
    const [queued] = await ws.sql<{ job_id: string; input: { ref: string } }[]>`select job_id, input from agent_runs where workspace_id = ${ws.id} and job_id = 'editing.prep'`;
    expect(queued?.input.ref).toBe(ref);
    const out = await runPrep(await ctxFor("editing.prep", { ref }));
    expect(out).toMatchObject({ ref, status: "review", approvalRef: expect.stringMatching(/^ap-\d+$/) });
    const view = await getEditJobView(ws, ref);
    const cuts = (view.cutList as { cuts: { kind: string; reason: string }[] }).cuts;
    expect(cuts.some((c) => c.kind === "edit_note" && /cut that/i.test(c.reason))).toBe(true);
    expect(cuts.some((c) => c.kind === "silence")).toBe(true);
    expect(view.waitingFor).toEqual([expect.objectContaining({ what: "cut list" })]);
    const [msg] = await ws.sql<{ ref: string; body: { text: string } }[]>`select ref, body from messages where workspace_id = ${ws.id} and ref = ${ref}`;
    expect(msg?.body.text).toMatch(/cut list is ready/);
  });

  it.runIf(live)("only a person approves the cut list; approval queues the plan", async () => {
    await expect(approveCutList(ws, "agent:art_director", ref, {})).rejects.toThrow(ToolError);
    await expect(getPlanContext(ws, ref)).rejects.toThrow(/hasn't been approved/);
    const r = await approveCutList(ws, "user:owner", ref, {});
    expect(r.status).toBe("planning");
    const [plan] = await ws.sql`select 1 from agent_runs where workspace_id = ${ws.id} and job_id = 'editing.plan' and input->>'ref' = ${ref}`;
    expect(plan).toBeTruthy();
    const [ap] = await ws.sql<{ status: string }[]>`select status from approvals where workspace_id = ${ws.id} and subject_type = 'edit_map'`;
    expect(ap?.status).toBe("approved");
  });

  it.runIf(live)("validates plans against the schema and the preflight plan gate", async () => {
    const ctx = await getPlanContext(ws, ref);
    expect(ctx.isDraft).toBe(true);
    expect((ctx.transcript as string[])[0]).toMatch(/^\[0\.\d\d–/);
    const D = ctx.outputDurationS as number;
    await expect(savePlan(ws, "agent:art_director", ref, { layout: { segments: [{ mode: "sideways", start: 0, dur: D }] } })).rejects.toThrow(/problem/);
    const noEvidence = { layout: { segments: [{ mode: "full", start: 0, dur: D }] }, overlays: [{ kind: "chart", at: 1, dur: 2, text: "Hours", props: { labels: ["a"], values: [3] } }] };
    await expect(savePlan(ws, "agent:art_director", ref, noEvidence)).rejects.toThrow(/plan check/);
    const saved = await savePlan(ws, "agent:art_director", ref, {
      layout: { segments: [{ mode: "full", start: 0, dur: D }] },
      captions: { style: "clean", emphasisWords: ["habit"] },
      overlays: [{ kind: "headline", at: 0, dur: 2.5, text: "The setup step most teams skip" }],
      camera: [{ kind: "zoom", at: 3, dur: 1.5, scale: 1.08 }],
    });
    expect(saved).toMatchObject({ ref, version: 1, saved: true });
  });

  it.runIf(live)("renders, finishes, passes QC and asks for final approval", { timeout: 240_000 }, async () => {
    const req = await requestRender(ws, "agent:art_director", ref);
    expect(req.queued).toBe(true);
    const rctx = await ctxFor("editing.render", { ref, version: 1 });
    const out = await runRender(rctx);
    await endAsRunner(rctx.runId);
    expect(out).toMatchObject({ ref, version: 1, approvalRef: expect.stringMatching(/^ap-/) });
    const path = out.output as string;
    expect(existsSync(path)).toBe(true);
    const probe = await ffprobe(path);
    expect(probe.video).toMatchObject({ displayWidth: 1080, displayHeight: 1920, fps: 30, codec: "h264" });
    const qc = await getQcReport(ws, ref);
    expect(qc.passed, JSON.stringify(qc.problems)).toBe(true);
    const job = await getEditJob(ws, ref);
    expect(job?.status).toBe("review");
    expect(job?.output_asset_id).toBeTruthy();
    const [asset] = await ws.sql<{ kind: string; sha256: string }[]>`select kind, sha256 from media_assets where id = ${job!.output_asset_id}`;
    expect(asset).toMatchObject({ kind: "render", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it.runIf(live)("a revision note on a pending video becomes an editing.revise run with the ops input shape", { timeout: 60_000 }, async () => {
    const r = await addRevisionNote(ws, "user:owner", ref, "add a soft whoosh at the start");
    expect(r).toMatchObject({ fromVersion: 1, nextVersion: 2 });
    const [renderRun] = await ws.sql<{ id: string; input: { approval?: { decision: string; ref: string; note: string } } }[]>`
      select id, input from agent_runs where workspace_id = ${ws.id} and job_id = 'editing.render' and input ? 'approval'`;
    expect(renderRun?.input.approval?.decision).toBe("revised");
    await runRender(await ctxFor("editing.render", { ref, approval: { ref: renderRun!.input.approval!.ref, decision: "revised" as const, note: "add a soft whoosh at the start" } }));
    const [rev] = await ws.sql<{ input: Record<string, unknown> }[]>`select input from agent_runs where workspace_id = ${ws.id} and job_id = 'editing.revise'`;
    expect(rev?.input).toMatchObject({ ref, fromVersion: 1, notes: "add a soft whoosh at the start", source: { channel: "approval" } });
  });

  it.runIf(live)("an audio-only revision re-renders without touching the picture", { timeout: 240_000 }, async () => {
    const ctx = await getPlanContext(ws, ref);
    const plan = ctx.plan as Record<string, unknown> & { audio: { sfx: unknown[] } };
    plan.audio.sfx = [{ kind: "whoosh", at: 0.2 }];
    const saved = await savePlan(ws, "agent:art_director", ref, plan);
    expect(saved.version).toBe(2);
    await requestRender(ws, "agent:art_director", ref);
    const rctx = await ctxFor("editing.render", { ref, version: 2 });
    const out = await runRender(rctx);
    await endAsRunner(rctx.runId);
    expect(out.revision).toBe("audio_only");
    const job = await getEditJob(ws, ref);
    const report = job!.qc_report as { checks: { id: string; status: string }[]; render: { reusedChunks: number; chunks: number } };
    expect(report.render.reusedChunks).toBe(report.render.chunks);
    expect(report.checks.find((c) => c.id === "stream_hash")?.status).toBe("pass");
  });

  it.runIf(live)("final approval by a person signs off playback and claims", { timeout: 60_000 }, async () => {
    const [pending] = await ws.sql<{ ref: string }[]>`select ref from approvals where workspace_id = ${ws.id} and status = 'pending' and subject_type = 'edit_render'`;
    await decideApproval(ws.sql, ws.id, { refOrId: pending!.ref, decision: "approved", actor: "user:owner" });
    await runRender(await ctxFor("editing.render", { ref, approval: { ref: pending!.ref, decision: "approved" as const } }));
    const job = await getEditJob(ws, ref);
    expect(job?.status).toBe("approved");
    expect(job?.preflight?.signoffs.map((s) => s.kind).sort()).toEqual(["claims", "edit_map", "plan", "playback"]);
  });
});

describe(`research transcription hand-off${live ? "" : " (needs Postgres, uv and ffmpeg)"}`, () => {
  it.runIf(live)("transcribes a post and replies to research.ingest-transcript", { timeout: 60_000 }, async () => {
    const [post] = await ws.sql<{ id: string }[]>`
      insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url) values (${ws.id}, 'instagram', 'p1', 'demo_creator', 'https://example.com/p/1') returning id`;
    mkdirSync(join(root, "media", "research"), { recursive: true });
    await mediaPy("synth", { output: join(root, "media", "research", "p1.mp4"), script: say("this is a sample post."), width: 540, height: 960 });
    const then = { jobId: "research.teardown", agent: "analyst" as const, input: { externalPostId: post!.id } };
    const req = { kind: "external_post" as const, externalPostId: post!.id, url: "https://example.com/p/1", mediaPath: "research/p1.mp4", destDir: `research/${post!.id}`, replyTo: { jobId: "research.ingest-transcript" as const, agent: "analyst" as const }, then };
    const out = await runTranscribe(await ctxFor("editing.transcribe", req));
    expect(out.ok).toBe(true);
    const [reply] = await ws.sql<{ agent: string; input: unknown; parent_run_id: string | null }[]>`
      select agent, input, parent_run_id from agent_runs where workspace_id = ${ws.id} and job_id = 'research.ingest-transcript'`;
    expect(reply?.agent).toBe("analyst");
    expect(reply?.parent_run_id).toBeTruthy();
    const ingest = ingestTranscriptInputSchema.parse(reply!.input);
    expect(ingest).toMatchObject({ externalPostId: post!.id, mediaPath: "research/p1.mp4", then });
    expect(ingest.transcript?.words?.length).toBeGreaterThan(0);

    const missing = await runTranscribe(await ctxFor("editing.transcribe", { ...req, mediaPath: "research/nope.mp4", then: undefined }));
    expect(missing.ok).toBe(false);
    const replies = await ws.sql<{ input: { error?: { kind: string } } }[]>`select input from agent_runs where workspace_id = ${ws.id} and job_id = 'research.ingest-transcript' order by created_at`;
    expect(replies[1]?.input.error?.kind).toBe("unavailable");
  });
});

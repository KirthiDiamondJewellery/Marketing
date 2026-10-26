import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, defineNativeJob, defineLlmJob, loadBrandKit, parseConfig, silentLogger, type AttentionOSConfigInput, type ModuleDefinition, type WorkspaceContext } from "@attentionos/core";
import { enqueueRun, ensureWorkspace } from "@attentionos/db";
import { createTestDatabase, hasTestDatabase, NEEDS_DB } from "@attentionos/db/testing";
import { workspacePaths } from "@attentionos/runtime";
import type { RunResult } from "@attentionos/runner";
import { collectSchedules, nextClaim, Scheduler, startWorker, type WebhookCapable } from "../src/index.ts";

const ran: string[] = [];
const testModule: ModuleDefinition = defineModule({
  manifest: {
    id: "research", name: "Research", description: "", agent: "analyst", tier: "core", level: 1,
    dependsOn: [], requiredProviders: [], optionalProviders: [], requiresAcknowledgement: [],
    schedules: { "own-sync": "0 * * * *", "research.trend-radar": "*/30 * * * *", "research.write-kit": "0 8 * * *", "research.missing": "0 1 * * *" },
  },
  tools: [],
  jobs: [
    defineNativeJob({ kind: "native", id: "research.own-sync", agent: "analyst", description: "Sync", input: z.object({}).passthrough(), run: async (ctx) => { ran.push(`sync:${ctx.runId}`); return { ok: true }; } }),
    defineNativeJob({ kind: "native", id: "research.trend-radar", agent: "analyst", description: "Radar", input: z.object({}), run: async () => ({}) }),
    defineNativeJob({ kind: "native", id: "research.webhook-zernio", agent: "analyst", description: "Hook", input: z.object({}).passthrough(), run: async () => ({}) }),
    defineNativeJob({ kind: "native", id: "research.render", agent: "analyst", description: "Heavy", heavy: true, input: z.object({}).passthrough(), run: async () => ({}) }),
    defineLlmJob({ kind: "llm", id: "research.write-kit", agent: "analyst", description: "Kit", input: z.object({}), skill: "kit", prompt: () => "x", allowedTools: [] }),
  ],
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function workspace(sql: WorkspaceContext["sql"], slug: string, config: AttentionOSConfigInput = {}, secrets: Record<string, string> = {}): Promise<WorkspaceContext> {
  const root = mkdtempSync(join(tmpdir(), "aos-worker-"));
  roots.push(root);
  const parsed = parseConfig({ workspace: { name: "Examplebrand Studio", timezone: "UTC" }, ...config });
  const { id } = await ensureWorkspace(sql, { name: slug, slug, timezone: "UTC" });
  const paths = workspacePaths(root);
  return {
    id, paths, config: parsed, sql, providers: { trendSources: {} }, log: silentLogger,
    brand: () => loadBrandKit(paths.brand), reloadBrand: () => loadBrandKit(paths.brand),
    now: () => new Date(), secret: (n) => secrets[n],
  };
}

describe("schedules", () => {
  it("merges module defaults with config overrides", () => {
    const config = parseConfig({ modules: { research: { schedules: { "trend-radar": "", "research.own-sync": "15 6 * * *" } } }, agents: {} });
    const { entries, problems } = collectSchedules([testModule], config);
    expect(entries.map((e) => [e.jobId, e.cron, e.source])).toEqual([
      ["research.own-sync", "15 6 * * *", "config"],
      ["research.write-kit", "0 8 * * *", "module"],
    ]);
    expect(problems).toEqual(["The Research schedule names a job that doesn't exist: research.missing."]);
    const off = collectSchedules([testModule], parseConfig({ agents: { analyst: { enabled: false } } }));
    expect(off.entries).toEqual([]);
  });
});

describe("slots", () => {
  const cfg = { concurrency: 2, userSlots: 1, maxHeavy: 2, userPriority: 100 };
  const heavy = ["editing.render"];
  it("fills shared slots first, then the slot kept for user work", () => {
    expect(nextClaim([], cfg, heavy)).toEqual({ lane: "shared", filter: {} });
    expect(nextClaim([{ lane: "shared", heavy: false }], cfg, heavy)).toEqual({ lane: "shared", filter: {} });
    const sharedFull = [{ lane: "shared" as const, heavy: false }, { lane: "shared" as const, heavy: false }];
    expect(nextClaim(sharedFull, cfg, heavy)).toEqual({ lane: "user", filter: { minPriority: 100 } });
    expect(nextClaim([...sharedFull, { lane: "user", heavy: false }], cfg, heavy)).toBeNull();
    expect(nextClaim(sharedFull, { ...cfg, userSlots: 0 }, heavy)).toBeNull();
  });

  it("holds back heavy jobs at the limit, in every slot", () => {
    const twoRenders = [{ lane: "shared" as const, heavy: true }, { lane: "shared" as const, heavy: true }];
    expect(nextClaim(twoRenders, cfg, heavy)).toEqual({ lane: "user", filter: { minPriority: 100, excludeJobs: heavy } });
    expect(nextClaim([{ lane: "shared", heavy: true }], { ...cfg, maxHeavy: 1 }, heavy)).toEqual({ lane: "shared", filter: { excludeJobs: heavy } });
    expect(nextClaim(twoRenders, cfg, [])).toEqual({ lane: "user", filter: { minPriority: 100 } });
  });
});

const HAS_DB = await hasTestDatabase();

describe.skipIf(!HAS_DB)(`worker${NEEDS_DB}`, () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    db = await createTestDatabase("attentionos_test_o1_worker");
  });
  afterAll(async () => db?.drop());

  it("enqueues each scheduled fire once and skips AI jobs in Copilot mode", async () => {
    const ws = await workspace(db.sql, "sched");
    const { entries } = collectSchedules([testModule], ws.config);
    const scheduler = new Scheduler({ ws, entries, skipLlm: true });
    expect(await scheduler.tick(new Date("2026-10-10T07:59:00Z"))).toEqual({ enqueued: [], skipped: [] });
    const t1 = await scheduler.tick(new Date("2026-10-10T08:01:00Z"));
    expect(t1.enqueued.sort()).toEqual(["research.own-sync", "research.trend-radar"]);
    expect(t1.skipped).toEqual(["research.write-kit"]);

    // A second scheduler (another worker, or a restart) resumes from the saved cursor and never double-runs a slot.
    const again = new Scheduler({ ws, entries, skipLlm: true });
    expect((await again.tick(new Date("2026-10-10T08:02:00Z"))).enqueued).toEqual([]);
    const runs = await db.sql`select job_id, trigger, dedupe_key from agent_runs where workspace_id = ${ws.id} order by job_id`;
    expect(runs.map((r) => r.dedupe_key)).toEqual(["schedule:research.own-sync:2026-10-10T08:00:00.000Z", "schedule:research.trend-radar:2026-10-10T08:00:00.000Z"]);
    // While the previous own-sync is still queued, the next slot is skipped; trend-radar finished, so it runs again.
    await db.sql`update agent_runs set status = 'succeeded' where workspace_id = ${ws.id} and job_id = 'research.trend-radar'`;
    expect((await again.tick(new Date("2026-10-10T09:00:30Z"))).enqueued).toEqual(["research.trend-radar"]);
  });

  it("claims and runs queued jobs, fails unknown ones and retries provider hiccups", async () => {
    const ws = await workspace(db.sql, "loop");
    const results: Record<string, RunResult> = {};
    let calls = 0;
    const worker = await startWorker({
      ws, modules: [testModule], manual: true, webhookPort: null,
      runJob: async (_ws, job, _input, opts) => {
        calls++;
        const status = job.id === "research.trend-radar" ? "failed" : "succeeded";
        await db.sql`update agent_runs set status = ${status}, finished_at = now() where id = ${opts.runId!}`;
        const r: RunResult = { runId: opts.runId!, status, costUsd: 0, turns: 0, ...(status === "failed" ? { retryAfterMs: 30_000 } : {}) };
        results[job.id] = r;
        return r;
      },
    });
    const ok = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.own-sync", agent: "analyst" });
    const flaky = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.trend-radar", agent: "analyst" });
    const missing = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "editing.render", agent: "art_director" });
    await worker.tick();
    await worker.idle();
    await worker.tick();
    await worker.idle();
    const rows = Object.fromEntries((await db.sql`select id, status, error, run_after from agent_runs where workspace_id = ${ws.id}`).map((r) => [r.id, r]));
    expect(rows[ok.id]!.status).toBe("succeeded");
    expect(rows[missing.id]).toMatchObject({ status: "failed", error: "The job editing.render isn't installed or its module is turned off." });
    expect(rows[flaky.id]!.status).toBe("queued");
    // Compared on the database clock (the queue's clock), so host/DB clock skew can't flake it.
    const [retry] = await db.sql<{ later: boolean }[]>`select run_after > now() + interval '20 seconds' as later from agent_runs where id = ${flaky.id}`;
    expect(retry!.later).toBe(true);
    expect(calls).toBe(2);
    await worker.stop();
  });

  it("starts user work at once while background jobs fill the shared slots, and caps heavy jobs", async () => {
    const ws = await workspace(db.sql, "lanes");
    const release = new Map<string, () => void>();
    const worker = await startWorker({
      ws, modules: [testModule], manual: true, webhookPort: null, concurrency: 1, userSlots: 1, maxHeavy: 1,
      runJob: (_ws, _job, _input, opts) =>
        new Promise((resolve) => {
          release.set(opts.runId!, async () => {
            await db.sql`update agent_runs set status = 'succeeded', finished_at = now() where id = ${opts.runId!}`;
            resolve({ runId: opts.runId!, status: "succeeded", costUsd: 0, turns: 0 });
          });
        }),
    });
    const bg1 = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.own-sync", agent: "analyst", trigger: "schedule" });
    const bg2 = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.trend-radar", agent: "analyst", trigger: "schedule" });
    await worker.tick();
    expect(worker.active()).toEqual([bg1.id]);

    // The shared slot is busy with background work; the user's run takes the reserved slot.
    const mine = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.own-sync", agent: "analyst", trigger: "manual", createdBy: "user:studio" });
    await worker.tick();
    expect(worker.active().sort()).toEqual([bg1.id, mine.id].sort());
    // Background work never takes the reserved slot.
    await worker.tick();
    expect(worker.active()).not.toContain(bg2.id);

    // A finished run frees its slot and the next run starts without waiting for a poll: here the background one.
    release.get(mine.id)!();
    await expect.poll(() => worker.active()).toEqual([bg1.id]);
    release.get(bg1.id)!();
    await expect.poll(() => worker.active()).toEqual([bg2.id]);

    // Heavy jobs: at most maxHeavy at once, even when a user render could use the reserved slot.
    const r1 = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.render", agent: "analyst", createdBy: "user:studio" });
    const r2 = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.render", agent: "analyst", createdBy: "user:studio" });
    await worker.tick();
    expect(worker.active().sort()).toEqual([bg2.id, r1.id].sort());
    release.get(bg2.id)!();
    await expect.poll(() => worker.active()).toEqual([r1.id]);
    await worker.tick();
    expect(worker.active()).toEqual([r1.id]);
    release.get(r1.id)!();
    await expect.poll(() => worker.active()).toEqual([r2.id]);
    release.get(r2.id)!();
    await worker.idle();
    await worker.stop();
  });

  it("claims new work the moment it's queued (LISTEN/NOTIFY), with polling only as a fallback", { timeout: 60_000 }, async () => {
    const ws = await workspace(db.sql, "instant");
    // Polling every 60 s, so a claim well inside that window can only come from NOTIFY. Bounds are generous on purpose:
    // a loaded CI machine can take seconds, but never a full poll interval.
    const POLL_MS = 60_000;
    const started: { at: number; due: boolean }[] = [];
    const worker = await startWorker({
      ws, modules: [testModule], webhookPort: null, pollMs: POLL_MS, heartbeatMs: POLL_MS,
      runJob: async (_ws, _job, _input, opts) => {
        // Was the run due when it started? Asked on the database clock, the one the queue uses.
        const [row] = await db.sql<{ due: boolean }[]>`select clock_timestamp() >= run_after as due from agent_runs where id = ${opts.runId!}`;
        started.push({ at: Date.now(), due: row!.due });
        await db.sql`update agent_runs set status = 'succeeded', finished_at = now() where id = ${opts.runId!}`;
        return { runId: opts.runId!, status: "succeeded", costUsd: 0, turns: 0 };
      },
    });
    await worker.idle();
    const t0 = Date.now();
    await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.own-sync", agent: "analyst", trigger: "chat", createdBy: "user:studio" });
    await expect.poll(() => started.length, { timeout: 20_000, interval: 10 }).toBe(1);
    expect(started[0]!.at - t0).toBeLessThan(POLL_MS / 2);
    // A delayed run (say, the pipeline check in 0.4 s) is claimed when it comes due, not before and not on the next poll.
    const [clock] = await db.sql<{ now: Date }[]>`select clock_timestamp() as now`;
    const t1 = Date.now();
    await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.own-sync", agent: "analyst", runAfter: new Date(clock!.now.getTime() + 400) });
    await expect.poll(() => started.length, { timeout: 20_000, interval: 10 }).toBe(2);
    expect(started[1]!.due).toBe(true);
    expect(started[1]!.at - t1).toBeLessThan(POLL_MS / 2);
    await worker.stop();
  });

  it("puts runs back on the queue when stopped mid-run", async () => {
    const ws = await workspace(db.sql, "shutdown");
    const worker = await startWorker({
      ws, modules: [testModule], manual: true, webhookPort: null, shutdownGraceMs: 20,
      runJob: (_ws, _job, _input, opts) =>
        new Promise((resolve) => {
          opts.signal!.addEventListener("abort", async () => {
            await db.sql`update agent_runs set status = 'cancelled', error = 'Cancelled.' where id = ${opts.runId!}`;
            resolve({ runId: opts.runId!, status: "cancelled", costUsd: 0, turns: 0 });
          });
        }),
    });
    const run = await enqueueRun(db.sql, { workspaceId: ws.id, jobId: "research.own-sync", agent: "analyst" });
    await worker.tick();
    expect(worker.active()).toEqual([run.id]);
    await worker.stop();
    const [row] = await db.sql`select status, attempts, error, claimed_by from agent_runs where id = ${run.id}`;
    expect(row).toMatchObject({ status: "queued", attempts: 0, error: null, claimed_by: null });
  });

  it("receives webhooks with a shared secret or the provider's own check", async () => {
    const ws = await workspace(db.sql, "hooks", {}, { ATTENTIONOS_WEBHOOK_SECRET: "s3cret" });
    const worker = await startWorker({ ws, modules: [testModule], manual: true, webhookPort: 0, runJob: async () => ({ runId: "", status: "succeeded", costUsd: 0, turns: 0 }) });
    const url = worker.webhookUrl!;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    expect((await post("/webhooks/zernio", { event: "post.published" })).status).toBe(401);
    expect((await post("/webhooks/zernio", { event: "post.published" }, { "x-attentionos-secret": "nope" })).status).toBe(401);
    const ok = await post("/webhooks/zernio", { event: "post.published" }, { "x-attentionos-secret": "s3cret", "webhook-id": "evt_1" });
    expect(ok.status).toBe(202);
    const body = (await ok.json()) as { queued: boolean; runId: string };
    expect(body.queued).toBe(true);
    const dup = (await (await post("/webhooks/zernio", {}, { "x-attentionos-secret": "s3cret", "webhook-id": "evt_1" })).json()) as { duplicate: boolean };
    expect(dup.duplicate).toBe(true);
    const [run] = await db.sql`select job_id, trigger, input from agent_runs where id = ${body.runId}`;
    expect(run).toMatchObject({ job_id: "research.webhook-zernio", trigger: "webhook", input: { provider: "zernio", payload: { event: "post.published" } } });
    expect((await post("/webhooks/unknown", {}, { "x-attentionos-secret": "s3cret" })).status).toBe(404);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    await worker.stop();

    // A provider that verifies its own signatures and picks the job.
    const zernio: WebhookCapable & { id: string; health(): Promise<{ ok: boolean; detail: string }> } = {
      id: "zernio",
      health: async () => ({ ok: true, detail: "" }),
      verifyWebhook: (req) => req.headers["x-zernio-signature"] === "valid",
      webhookJob: (payload) => ({ jobId: "research.own-sync", input: { reason: (payload as { event: string }).event } }),
    };
    const ws2 = { ...ws, providers: { trendSources: {}, ownAnalytics: zernio as never } };
    const w2 = await startWorker({ ws: ws2, modules: [testModule], manual: true, webhookPort: 0, runJob: async () => ({ runId: "", status: "succeeded", costUsd: 0, turns: 0 }) });
    const bad = await fetch(`${w2.webhookUrl}/webhooks/zernio`, { method: "POST", body: "{}", headers: { "x-zernio-signature": "forged" } });
    expect(bad.status).toBe(401);
    const good = await fetch(`${w2.webhookUrl}/webhooks/zernio`, { method: "POST", body: '{"event":"analytics.synced"}', headers: { "x-zernio-signature": "valid" } });
    const out = (await good.json()) as { runId: string };
    const [r2] = await db.sql`select job_id, input from agent_runs where id = ${out.runId}`;
    expect(r2).toMatchObject({ job_id: "research.own-sync", input: { reason: "analytics.synced" } });
    await w2.stop();
  });
});

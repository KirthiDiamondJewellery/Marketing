import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimRun,
  countPendingApprovals,
  decideApproval,
  enqueueRun,
  ensureWorkspace,
  expediteRun,
  finishRun,
  heartbeatRuns,
  listApprovals,
  recordCost,
  recoverStaleRuns,
  requestApproval,
  requeueRun,
  RUN_NOTIFY_CHANNEL,
  RUN_PRIORITY,
  spendTodayMicro,
  withRunScope,
} from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

describe("queue, approvals and spend", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let ws: string;
  let other: string;
  beforeAll(async () => {
    db = await createTestDatabase("attentionos_test_o1_queue");
    ws = (await ensureWorkspace(db.sql, { name: "Examplebrand Studio", slug: "examplebrand", timezone: "America/Chicago" })).id;
    other = (await ensureWorkspace(db.sql, { name: "Other", slug: "other", timezone: "UTC" })).id;
  });
  afterAll(async () => db?.drop());

  it("claims only this workspace's runs, once each, in order", async () => {
    await enqueueRun(db.sql, { workspaceId: other, jobId: "research.own-sync", agent: "analyst" });
    const a = await enqueueRun(db.sql, { workspaceId: ws, jobId: "research.own-sync", agent: "analyst" });
    const b = await enqueueRun(db.sql, { workspaceId: ws, jobId: "strategy.daily-brief", agent: "strategist" });
    await enqueueRun(db.sql, { workspaceId: ws, jobId: "later", agent: "analyst", runAfter: new Date(Date.now() + 3_600_000) });

    const [c1, c2] = await Promise.all([claimRun(db.sql, ws, "w1"), claimRun(db.sql, ws, "w2")]);
    expect(new Set([c1?.id, c2?.id])).toEqual(new Set([a.id, b.id]));
    expect(c1?.status).toBe("running");
    expect(c1?.attempts).toBe(1);
    expect(await claimRun(db.sql, ws, "w3")).toBeNull();

    const onlyStrategist = await enqueueRun(db.sql, { workspaceId: ws, jobId: "x", agent: "copywriter" });
    expect(await claimRun(db.sql, ws, "w3", ["strategist"])).toBeNull();
    expect((await claimRun(db.sql, ws, "w3", ["copywriter"]))?.id).toBe(onlyStrategist.id);
  });

  it("claims user work before background work, then by run_after and age", async () => {
    await db.sql`update agent_runs set status = 'cancelled' where workspace_id = ${ws} and status = 'queued'`;
    const old = new Date(Date.now() - 3_600_000);
    const bg = await enqueueRun(db.sql, { workspaceId: ws, jobId: "research.competitor-scan", agent: "analyst", trigger: "schedule", runAfter: old });
    const upload = await enqueueRun(db.sql, { workspaceId: ws, jobId: "production.match-upload", agent: "art_director", trigger: "event", createdBy: "user:studio" });
    const chat = await enqueueRun(db.sql, { workspaceId: ws, jobId: "ops.chief-of-staff", agent: "chief_of_staff", trigger: "chat", createdBy: "user:telegram:1" });
    const pinned = await enqueueRun(db.sql, { workspaceId: ws, jobId: "ops.outbox", agent: "chief_of_staff", trigger: "schedule", priority: 105 });

    const rows = await db.sql<{ id: string; priority: number }[]>`select id, priority from agent_runs where id = any(${[bg.id, upload.id, chat.id, pinned.id]})`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.priority]))).toEqual({
      [bg.id]: RUN_PRIORITY.background,
      [upload.id]: RUN_PRIORITY.user,
      [chat.id]: RUN_PRIORITY.chat,
      [pinned.id]: 105,
    });
    // Background work queued an hour earlier still waits; a reserved user slot never takes it.
    expect((await claimRun(db.sql, ws, "w1"))?.id).toBe(chat.id);
    expect((await claimRun(db.sql, ws, "w1"))?.id).toBe(pinned.id);
    expect((await claimRun(db.sql, ws, "w1", undefined, { minPriority: RUN_PRIORITY.user }))?.id).toBe(upload.id);
    expect(await claimRun(db.sql, ws, "w1", undefined, { minPriority: RUN_PRIORITY.user })).toBeNull();
    expect(await claimRun(db.sql, ws, "w1", undefined, { excludeJobs: ["research.competitor-scan"] })).toBeNull();
    expect((await claimRun(db.sql, ws, "w1"))?.id).toBe(bg.id);

    // Within one priority, an earlier run_after (an earlier film-by deadline) goes first.
    const later = await enqueueRun(db.sql, { workspaceId: ws, jobId: "editing.prep", agent: "art_director", createdBy: "user:studio" });
    const sooner = await enqueueRun(db.sql, { workspaceId: ws, jobId: "editing.prep", agent: "art_director", createdBy: "user:studio", runAfter: old });
    expect((await claimRun(db.sql, ws, "w1"))?.id).toBe(sooner.id);
    expect((await claimRun(db.sql, ws, "w1"))?.id).toBe(later.id);
  });

  it("gives follow-up runs their parent's priority", async () => {
    await db.sql`update agent_runs set status = 'cancelled' where workspace_id = ${ws} and status = 'queued'`;
    // An upload (user) kicks the pipeline check, whose job code queues prep, which queues the plan.
    const advance = await enqueueRun(db.sql, { workspaceId: ws, jobId: "production.advance", agent: "art_director", trigger: "event", createdBy: "system", priority: RUN_PRIORITY.user });
    const prep = await withRunScope(advance.id, () => enqueueRun(db.sql, { workspaceId: ws, jobId: "editing.prep", agent: "art_director", trigger: "event", createdBy: "system" }));
    const plan = await enqueueRun(db.sql, { workspaceId: ws, jobId: "editing.plan", agent: "art_director", trigger: "handoff", createdBy: "agent:art_director", parentRunId: prep.id });
    // A raw insert from an agent run's MCP server: its connection names the run.
    const scan = await enqueueRun(db.sql, { workspaceId: ws, jobId: "research.daily-scan", agent: "analyst", trigger: "schedule" });
    const [teardown] = await db.sql.begin(async (tx) => {
      await tx`select set_config('attentionos.run_id', ${scan.id}, true)`;
      return tx<{ id: string }[]>`insert into agent_runs (workspace_id, agent, job_id, trigger, input, created_by) values (${ws}, 'analyst', 'research.teardown', 'manual', '{}', 'agent:analyst') returning id`;
    });
    // A root manual run (CLI, Run now) counts as asked for; the same from inside a background run doesn't.
    const cli = await enqueueRun(db.sql, { workspaceId: ws, jobId: "research.trend-radar", agent: "analyst" });
    const fromBg = await withRunScope(scan.id, () => enqueueRun(db.sql, { workspaceId: ws, jobId: "research.trend-writer", agent: "analyst", createdBy: "agent:analyst" }));

    const rows = await db.sql<{ id: string; priority: number; parent_run_id: string | null }[]>`
      select id, priority, parent_run_id from agent_runs where id = any(${[prep.id, plan.id, teardown!.id, cli.id, fromBg.id]})`;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[prep.id]).toMatchObject({ priority: RUN_PRIORITY.user, parent_run_id: advance.id });
    expect(by[plan.id]).toMatchObject({ priority: RUN_PRIORITY.user, parent_run_id: prep.id });
    expect(by[teardown!.id]).toMatchObject({ priority: RUN_PRIORITY.background, parent_run_id: scan.id });
    expect(by[cli.id]).toMatchObject({ priority: RUN_PRIORITY.user, parent_run_id: null });
    expect(by[fromBg.id]).toMatchObject({ priority: RUN_PRIORITY.background, parent_run_id: scan.id });

    // A run id from another workspace (or one that doesn't exist) is ignored rather than linked.
    const elsewhere = await withRunScope(advance.id, () => enqueueRun(db.sql, { workspaceId: other, jobId: "research.own-sync", agent: "analyst", trigger: "schedule" }));
    const [e] = await db.sql`select priority, parent_run_id from agent_runs where id = ${elsewhere.id}`;
    expect(e).toMatchObject({ priority: 0, parent_run_id: null });
  });

  it("moves background work up when a person asks for it, and on a person's decision", async () => {
    await db.sql`update agent_runs set status = 'cancelled' where workspace_id = ${ws} and status = 'queued'`;
    const handoff = await enqueueRun(db.sql, {
      workspaceId: ws, jobId: "scripting.write-script", agent: "copywriter", trigger: "handoff", createdBy: "agent:strategist",
      dedupeKey: "write-script:c1", runAfter: new Date(Date.now() + 10 * 60_000),
    });
    const asked = await enqueueRun(db.sql, { workspaceId: ws, jobId: "scripting.write-script", agent: "copywriter", createdBy: "user:studio", dedupeKey: "write-script:c1" });
    expect(asked).toEqual({ id: handoff.id, deduped: true });
    let [row] = await db.sql<{ priority: number; due: boolean }[]>`select priority, run_after <= now() as due from agent_runs where id = ${handoff.id}`;
    expect(row).toEqual({ priority: RUN_PRIORITY.user, due: true });
    expect(await expediteRun(db.sql, ws, handoff.id)).toBe(false);

    // (In the other workspace, so the approvals test below starts from an empty queue.)
    const brief = await enqueueRun(db.sql, { workspaceId: other, jobId: "strategy.daily-brief", agent: "strategist", trigger: "schedule" });
    await db.sql`update agent_runs set status = 'cancelled' where workspace_id = ${other} and status = 'queued' and id <> ${brief.id}`;
    expect((await claimRun(db.sql, other, "w1"))?.id).toBe(brief.id);
    await finishRun(db.sql, brief.id, { status: "waiting_approval" });
    const { approval } = await requestApproval(db.sql, other, { kind: "other", subjectType: "brief", agent: "strategist", summary: "Plan for today", runId: brief.id });
    await decideApproval(db.sql, other, { refOrId: approval.ref, decision: "approved", actor: "user:studio" });
    [row] = await db.sql<{ priority: number; due: boolean }[]>`select priority, status = 'queued' as due from agent_runs where id = ${brief.id}`;
    expect(row).toEqual({ priority: RUN_PRIORITY.user, due: true });
  });

  it("notifies listeners when a run is queued or re-queued", async () => {
    const heard: { ws: string; priority: number; inMs: number }[] = [];
    const listener = await db.sql.listen(RUN_NOTIFY_CHANNEL, (p) => heard.push(JSON.parse(p) as (typeof heard)[number]));
    const now = await enqueueRun(db.sql, { workspaceId: ws, jobId: "ops.chief-of-staff", agent: "chief_of_staff", trigger: "chat", createdBy: "user:studio" });
    await enqueueRun(db.sql, { workspaceId: ws, jobId: "production.advance", agent: "art_director", trigger: "event", runAfter: new Date(Date.now() + 5_000) });
    await claimRun(db.sql, ws, "w1", undefined, { minPriority: RUN_PRIORITY.chat });
    await requeueRun(db.sql, now.id);
    await expect.poll(() => heard.length, { timeout: 3_000 }).toBe(3);
    expect(heard[0]).toMatchObject({ ws, priority: RUN_PRIORITY.chat, inMs: 0 });
    expect(heard[1]!.inMs).toBeGreaterThan(3_000);
    expect(heard[2]).toMatchObject({ priority: RUN_PRIORITY.chat, inMs: 0 });
    await listener.unlisten();
  });

  it("dedupes by key across states and skips while a job is active", async () => {
    const first = await enqueueRun(db.sql, { workspaceId: ws, jobId: "learn.snapshot", agent: "analyst", dedupeKey: "schedule:learn.snapshot:2026-10-10T14:00:00.000Z" });
    const second = await enqueueRun(db.sql, { workspaceId: ws, jobId: "learn.snapshot", agent: "analyst", dedupeKey: "schedule:learn.snapshot:2026-10-10T14:00:00.000Z" });
    expect(second).toEqual({ id: first.id, deduped: true });
    await finishRun(db.sql, first.id, { status: "succeeded" });
    const third = await enqueueRun(db.sql, { workspaceId: ws, jobId: "learn.snapshot", agent: "analyst", dedupeKey: "schedule:learn.snapshot:2026-10-10T14:00:00.000Z" });
    expect(third.deduped).toBe(true);

    const active = await enqueueRun(db.sql, { workspaceId: ws, jobId: "ops.brief", agent: "chief_of_staff", skipIfActive: true });
    const skipped = await enqueueRun(db.sql, { workspaceId: ws, jobId: "ops.brief", agent: "chief_of_staff", skipIfActive: true });
    expect(skipped).toEqual({ id: active.id, deduped: true });
  });

  it("recovers stale runs: requeue, then fail after max attempts", async () => {
    await db.sql`update agent_runs set status = 'cancelled' where workspace_id = ${ws} and status = 'queued'`;
    const run = await enqueueRun(db.sql, { workspaceId: ws, jobId: "editing.render", agent: "art_director", maxAttempts: 2 });
    let claimed = await claimRun(db.sql, ws, "w1");
    expect(claimed?.id).toBe(run.id);
    await heartbeatRuns(db.sql, [run.id], "w1");
    expect(await recoverStaleRuns(db.sql, 60)).toBe(0);

    await db.sql`update agent_runs set heartbeat_at = now() - interval '10 minutes' where id = ${run.id}`;
    expect(await recoverStaleRuns(db.sql, 60)).toBeGreaterThanOrEqual(1);
    let [row] = await db.sql`select status, claimed_by from agent_runs where id = ${run.id}`;
    expect(row).toMatchObject({ status: "queued", claimed_by: null });

    await db.sql`update agent_runs set run_after = now() where id = ${run.id}`;
    claimed = await claimRun(db.sql, ws, "w2");
    expect(claimed?.attempts).toBe(2);
    await db.sql`update agent_runs set heartbeat_at = now() - interval '10 minutes' where id = ${run.id}`;
    await recoverStaleRuns(db.sql, 60);
    [row] = await db.sql`select status, error from agent_runs where id = ${run.id}`;
    expect(row).toMatchObject({ status: "failed", error: "worker stopped responding" });
  });

  it("requeues a run on graceful shutdown without spending an attempt", async () => {
    const run = await enqueueRun(db.sql, { workspaceId: ws, jobId: "research.trend-radar", agent: "analyst" });
    await claimRun(db.sql, ws, "w1");
    await requeueRun(db.sql, run.id, { refundAttempt: true });
    const [row] = await db.sql`select status, attempts from agent_runs where id = ${run.id}`;
    expect(row).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("runs the approvals queue with human-only decisions and run resumption", async () => {
    const run = await enqueueRun(db.sql, { workspaceId: ws, jobId: "scripting.write", agent: "copywriter" });
    await finishRun(db.sql, run.id, { status: "waiting_approval" });
    const subject = "9d7b2a1e-5c1f-4a0e-8d55-2b8f6f3c9e10";
    const { approval, created } = await requestApproval(db.sql, ws, { kind: "script", subjectType: "content", subjectId: subject, agent: "copywriter", summary: "Script for Thursday", runId: run.id });
    expect(created).toBe(true);
    expect(approval.ref).toMatch(/^ap-\d+$/);
    const dup = await requestApproval(db.sql, ws, { kind: "script", subjectType: "content", subjectId: subject, agent: "copywriter", summary: "again" });
    expect(dup).toMatchObject({ created: false, approval: { id: approval.id } });
    expect(await countPendingApprovals(db.sql, ws)).toBe(1);

    await expect(decideApproval(db.sql, ws, { refOrId: approval.ref, decision: "approved", actor: "agent:copywriter" })).rejects.toThrow(/Only a person/);
    const decided = await decideApproval(db.sql, ws, { refOrId: approval.ref.toUpperCase(), decision: "revised", actor: "user:local", note: "Shorter hook" });
    expect(decided).toMatchObject({ status: "revised", decided_by: "user:local", decision_note: "Shorter hook" });
    const [r] = await db.sql`select status, input from agent_runs where id = ${run.id}`;
    expect(r!.status).toBe("queued");
    expect(r!.input).toMatchObject({ approval: { ref: approval.ref, decision: "revised" } });
    await expect(decideApproval(db.sql, ws, { refOrId: approval.ref, decision: "approved", actor: "user:local" })).rejects.toThrow(/already revised/);
    expect((await listApprovals(db.sql, ws, { status: "all" })).length).toBe(1);
    const [event] = await db.sql`select kind, message from agent_events where workspace_id = ${ws} and kind = 'approval'`;
    expect(event!.message).toMatch(/Asked for changes on ap-/);
  });

  it("sums today's spend in the workspace timezone", async () => {
    const now = new Date("2026-10-10T15:00:00Z"); // 10:00 in Chicago
    await db.sql`insert into cost_ledger (workspace_id, ts, category, provider, amount_micro) values
      (${ws}, '2026-10-10T04:30:00Z', 'llm', 'anthropic', 1000000),
      (${ws}, '2026-10-10T05:30:00Z', 'llm', 'anthropic', 250000),
      (${ws}, '2026-10-10T06:00:00Z', 'scraping', 'apify', 990000)`;
    await recordCost(db.sql, { workspaceId: ws, category: "llm", provider: "anthropic", amountMicro: 0 });
    // 04:30Z is 23:30 the previous day in Chicago, so only the 05:30Z row counts.
    expect(await spendTodayMicro(db.sql, ws, "America/Chicago", now)).toBe(250000);
    expect(await spendTodayMicro(db.sql, ws, "UTC", now)).toBe(1250000);
  });
});

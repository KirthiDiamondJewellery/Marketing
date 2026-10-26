import { ProviderError, silentLogger, type JobContext, type Sql, type WorkspaceContext } from "@attentionos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mod from "../src/index.ts";
import { announceNewApprovals, decideApproval, listApprovals } from "../src/lib/approvals.ts";
import { processInbound } from "../src/lib/chat.ts";
import { dispatchOutbox, enqueueMessage, raiseAlert } from "../src/lib/outbox.ts";
import { setSetting } from "../src/lib/store.ts";
import { SETTING_KEYS } from "../src/settings.ts";
import { createTestDatabase, databaseAvailable, fakeNotifier, makeWorkspace } from "./helpers/db.ts";

const available = await databaseAvailable();

function jobCtx<I>(ws: WorkspaceContext, input: I): JobContext<I> {
  return { ws, input, actor: "system", runId: "00000000-0000-4000-8000-000000000000", log: silentLogger, signal: new AbortController().signal, progress: async () => {} };
}

const inbound = (messageId: string, extra: Record<string, unknown>) => ({ channel: "telegram", messageId, text: "", from: "4242", at: "2026-10-13T15:00:00Z", ...extra });

describe.skipIf(!available)("ops with Postgres", () => {
  let db: { sql: Sql; drop(): Promise<void> };
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });

  async function seedApproval(ws: WorkspaceContext, ref: string, opts: { withRun?: boolean; summary?: string } = {}) {
    let runId: string | null = null;
    if (opts.withRun) {
      const [run] = await db.sql<{ id: string }[]>`
        insert into agent_runs (workspace_id, agent, job_id, status, input) values (${ws.id}, 'copywriter', 'scripting.write-script', 'waiting_approval', '{"contentId":"c1"}') returning id`;
      runId = run!.id;
    }
    await db.sql`
      insert into approvals (workspace_id, ref, kind, subject_type, agent, summary, preview, run_id)
      values (${ws.id}, ${ref}, 'script', 'script', 'copywriter', ${opts.summary ?? "Script: 3 permit mistakes"}, ${db.sql.json({ text: "Most renovation delays start before demo day." })}, ${runId})`;
    return runId;
  }

  it("approves by button, resumes the paused run and confirms once", async () => {
    const n = fakeNotifier();
    const ws = await makeWorkspace(db.sql, { notifier: n });
    const runId = await seedApproval(ws, "ap-7", { withRun: true });

    n.push(inbound("cb:1", { actionId: "approve:ap-7", replyToRef: "ap-7" }));
    const r = await processInbound(ws);
    expect(r.handled).toEqual([{ messageId: "cb:1", intent: "decide", reply: "Approved ap-7: Script: 3 permit mistakes. Copywriter will take it from here." }]);
    expect(n.sent.map((m) => m.text)).toEqual(["Approved ap-7: Script: 3 permit mistakes. Copywriter will take it from here."]);

    const [a] = await db.sql`select status, decided_by from approvals where workspace_id = ${ws.id} and ref = 'ap-7'`;
    expect(a).toEqual({ status: "approved", decided_by: "user:telegram:4242" });
    const [run] = await db.sql`select status, input from agent_runs where id = ${runId}`;
    expect(run).toEqual({ status: "queued", input: { contentId: "c1", approval: { ref: "ap-7", decision: "approve" } } });

    // The same press delivered again (cursor not saved) is ignored.
    n.push(inbound("cb:1", { actionId: "approve:ap-7" }));
    expect((await processInbound(ws)).handled).toEqual([]);
    expect(n.sent).toHaveLength(1);
    const [cursor] = await db.sql`select value from settings where workspace_id = ${ws.id} and key = 'ops.inbound_cursor.telegram'`;
    expect(cursor!.value).toEqual({ cursor: "2" });
  });

  it("is idempotent and requires a note to request changes", async () => {
    const ws = await makeWorkspace(db.sql);
    await seedApproval(ws, "ap-1");
    const first = await decideApproval(ws, { ref: "ap-1", decision: "reject", note: "too salesy", actor: "user:test" });
    expect(first).toMatchObject({ status: "rejected", changed: true, resumed: false });
    const again = await decideApproval(ws, { ref: "ap-1", decision: "approve", actor: "user:test" });
    expect(again).toMatchObject({ status: "rejected", changed: false });
    await seedApproval(ws, "ap-2");
    await expect(decideApproval(ws, { ref: "ap-2", decision: "revise", actor: "user:test" })).rejects.toThrow(/Say what should change/);
    await expect(decideApproval(ws, { ref: "ap-99", decision: "approve", actor: "user:test" })).rejects.toThrow(/no approval ap-99/);
    const [event] = await db.sql`select kind, message from agent_events where workspace_id = ${ws.id}`;
    expect(event).toEqual({ kind: "approval", message: "Rejected ap-1: Script: 3 permit mistakes" });
  });

  it("turns a reply to an edit into an editing.revise run", async () => {
    const n = fakeNotifier();
    const ws = await makeWorkspace(db.sql, { notifier: n });
    await db.sql`insert into edit_jobs (workspace_id, ref, version, status) values (${ws.id}, 'rf-123', 2, 'review')`;

    n.push(
      inbound("310", { text: "make the hook punchier", replyToRef: "rf-123 v2" }),
      inbound("311", { text: "rf-999 v1 shorter" }),
    );
    const r = await processInbound(ws);
    expect(r.handled.map((h) => h.reply)).toEqual([
      "rf-123: on it. Art Director is re-cutting v2 with your notes. You'll get v3 here.",
      "I couldn't find rf-999. Check the ref on the video message and try again.",
    ]);
    const runs = await db.sql`select job_id, agent, trigger, input, created_by from agent_runs where workspace_id = ${ws.id}`;
    expect(runs).toEqual([
      {
        job_id: "editing.revise",
        agent: "art_director",
        trigger: "chat",
        created_by: "user:telegram:4242",
        input: { ref: "rf-123", fromVersion: 2, notes: "make the hook punchier", source: { channel: "telegram", messageId: "310" } },
      },
    ]);
  });

  it("returns free text to the caller in Copilot mode and queues the Chief of Staff in Autopilot", async () => {
    const n = fakeNotifier();
    const ws = await makeWorkspace(db.sql, { notifier: n });
    n.push(inbound("400", { text: "what should I film this week?" }));
    const copilot = await processInbound(ws);
    expect(copilot.forYou).toEqual([{ from: "4242", at: "2026-10-13T15:00:00Z", text: "what should I film this week?" }]);

    n.push(inbound("401", { text: "and next week?" }));
    await processInbound(ws, { enqueueChat: true });
    const [run] = await db.sql`select job_id, agent, input, priority from agent_runs where workspace_id = ${ws.id}`;
    expect(run).toMatchObject({ job_id: "ops.chief-of-staff", agent: "chief_of_staff", input: { text: "and next week?", messageId: "401" }, priority: 110 });
  });

  it("gives the Chief of Staff today's brief and the approvals queue up front, with exact counts", async () => {
    const ws = await makeWorkspace(db.sql);
    await seedApproval(ws, "ap-31", { summary: "Script: 3 permit mistakes" });
    await seedApproval(ws, "ap-32", { summary: "Script: the bench that hides boots" });
    const job = mod.jobs.find((j) => j.id === "ops.chief-of-staff")!;
    if (job.kind !== "llm") throw new Error("expected an AI job");
    const prompt = await job.prompt(jobCtx(ws, { text: "what's waiting?", channel: "studio", messageId: "s-1" }) as never);
    expect(prompt).toContain("<snapshot");
    expect(prompt).toContain("Approvals waiting: 2 (script: 2)");
    expect(prompt).toContain("- ap-31 · Copywriter · script: Script: 3 permit mistakes");
    expect(prompt).toContain('dedupeKey "cos:s-1"');
  });

  it("holds normal messages during quiet hours and sends them when the window ends", async () => {
    const n = fakeNotifier();
    let now = new Date("2026-10-14T03:00:00Z"); // 22:00 in Chicago
    const ws = await makeWorkspace(db.sql, { notifier: n, now: () => now });

    n.push(inbound("500", { text: "quiet 21:30-07:00" }));
    await processInbound(ws);
    expect(n.sent.at(-1)!.text).toBe("Quiet hours set: 21:30 to 07:00 (America/Chicago). Urgent alerts still come through.");

    await enqueueMessage(ws, { text: "Weekly results are ready", priority: "normal" });
    await enqueueMessage(ws, { text: "A post failed to publish", priority: "high" });
    const night = await dispatchOutbox(ws);
    expect(night).toMatchObject({ sent: 1, held: 1, heldUntil: "2026-10-14T12:00:00.000Z" });
    expect(n.sent.at(-1)!.text).toBe("A post failed to publish");

    now = new Date("2026-10-14T12:05:00Z");
    expect(await dispatchOutbox(ws)).toMatchObject({ sent: 1, held: 0 });
    expect(n.sent.at(-1)!.text).toBe("Weekly results are ready");
  });

  it("dedupes alerts through alert_log and outbox messages by key", async () => {
    const n = fakeNotifier();
    let now = new Date("2026-10-13T12:00:00Z");
    const ws = await makeWorkspace(db.sql, { notifier: n, now: () => now });
    const alert = { key: "account-expired:instagram", text: "Instagram disconnected. Reconnect to resume publishing.", windowMinutes: 180 };

    expect(await raiseAlert(ws, alert)).toEqual({ sent: true, suppressed: 0 });
    now = new Date("2026-10-13T13:00:00Z");
    expect(await raiseAlert(ws, alert)).toEqual({ sent: false, suppressed: 1 });
    expect(await raiseAlert(ws, alert)).toEqual({ sent: false, suppressed: 2 });
    now = new Date("2026-10-13T15:30:00Z");
    expect(await raiseAlert(ws, alert)).toEqual({ sent: true, suppressed: 2 });
    await dispatchOutbox(ws);
    expect(n.sent.map((m) => m.text)).toEqual([alert.text, `${alert.text}\n_This happened 2 more times since the last alert._`]);

    expect(await enqueueMessage(ws, { text: "x", dedupeKey: "k1" })).not.toBeNull();
    expect(await enqueueMessage(ws, { text: "x", dedupeKey: "k1" })).toBeNull();
  });

  it("announces each new approval once, with buttons", async () => {
    const n = fakeNotifier();
    const ws = await makeWorkspace(db.sql, { notifier: n });
    await seedApproval(ws, "ap-8");
    expect(await announceNewApprovals(ws)).toBe(1);
    expect(await announceNewApprovals(ws)).toBe(0);
    await dispatchOutbox(ws);
    expect(n.sent[0]).toMatchObject({
      ref: "ap-8",
      format: "markdown",
      actions: [
        { id: "approve:ap-8", label: "Approve", style: "primary" },
        { id: "reject:ap-8", label: "Reject", style: "danger" },
      ],
    });
    expect(n.sent[0]!.text).toBe(
      "*Copywriter* (Cw) · script\nScript: 3 permit mistakes\n\nMost renovation delays start before demo day.\n\nApprove, reject, or reply with what you'd like changed.",
    );
  });

  it("retries transient failures and falls back to text when a file is refused", async () => {
    const n = fakeNotifier();
    const ws = await makeWorkspace(db.sql, { notifier: n });
    await enqueueMessage(ws, { text: "Brief" });
    n.failOnce(new ProviderError("telegram", "upstream", "timeout"));
    expect(await dispatchOutbox(ws)).toMatchObject({ sent: 0, retrying: 1 });
    expect(await dispatchOutbox(ws)).toMatchObject({ sent: 1 });

    await enqueueMessage(ws, { text: "Cut 2 is ready", attachments: [{ localPath: "media/renders/rf-1-v2.mp4" }] });
    n.failOnce(new ProviderError("telegram", "invalid_request", "too large"));
    expect(await dispatchOutbox(ws)).toMatchObject({ sent: 1 });
    expect(n.sent.at(-1)).toEqual({ text: "Cut 2 is ready\n\n(The file couldn't be sent here. It's in your workspace at media/renders/rf-1-v2.mp4.)" });
  });

  it("masks other people's names in demo mode but keeps numbers", async () => {
    const ws = await makeWorkspace(db.sql);
    await db.sql`insert into contacts (workspace_id, name, handle) values (${ws.id}, 'Pat Example', 'pat.builds')`;
    await seedApproval(ws, "ap-3", { summary: "Reply to Pat Example (@pat.builds) about a $42,000 kitchen" });
    expect((await listApprovals(ws)).items[0]!.summary).toBe("Reply to Pat Example (@pat.builds) about a $42,000 kitchen");
    await setSetting(ws, SETTING_KEYS.demoMode, { on: true });
    const masked = (await listApprovals(ws)).items[0]!.summary;
    expect(masked).not.toMatch(/Pat|pat\.builds/);
    expect(masked).toContain("about a $42,000 kitchen");
  });

  it("sends the morning brief once a day from real data", async () => {
    const n = fakeNotifier();
    const now = new Date("2026-10-13T12:30:00Z"); // 07:30 in Chicago
    const ws = await makeWorkspace(db.sql, { notifier: n, now: () => now });
    await db.sql`
      insert into content (workspace_id, title, status, lane, film_by, brief)
      values (${ws.id}, '3 permit mistakes', 'scripted', 'Myth bust', '2026-10-13T21:00:00Z', ${db.sql.json({ header: "Permits, explained" })})`;
    const [post] = await db.sql<{ id: string }[]>`
      insert into posts (workspace_id, platform, provider, status, published_at, caption, idempotency_key)
      values (${ws.id}, 'instagram', 'zernio', 'published', '2026-10-12T17:00:00Z', 'Tile choices that age well', 'k-1') returning id`;
    await db.sql`insert into post_metrics (workspace_id, post_id, snapshot, views, x_score) values (${ws.id}, ${post!.id}, '24h', 18450, 2.43)`;
    await seedApproval(ws, "ap-4");

    const job = mod.jobs.find((j) => j.id === "ops.morning-brief")!;
    if (job.kind !== "native") throw new Error("expected native job");
    const first = (await job.run(jobCtx(ws, { force: false }))) as { sent: boolean };
    expect(first.sent).toBe(true);
    const text = n.sent[0]!.text;
    expect(text).toContain("*Morning brief, Tue, Oct 13*");
    expect(text).toContain('3 permit mistakes: "Permits, explained" (Myth bust · film by today 4:00 PM)');
    expect(text).toContain("ap-4 · Copywriter: Script: 3 permit mistakes");
    expect(text).toContain("Tile choices that age well on Instagram: 18k views, 2.4× your usual");
    expect(n.sent[0]!.actions).toEqual([{ id: "approvals", label: "Review 1 waiting" }]);

    const second = (await job.run(jobCtx(ws, { force: false }))) as { sent: boolean };
    expect(second.sent).toBe(false);
    expect(n.sent).toHaveLength(1);
  });

  it("exposes the brief and settings through MCP tools", async () => {
    const ws = await makeWorkspace(db.sql, { notifier: fakeNotifier() });
    const tool = (name: string) => mod.tools.find((t) => t.name === name)!;
    const brief = (await tool("ops_get_morning_brief").handler({ ws, actor: "user:test" }, { format: "both" } as never)) as { markdown: string; data: unknown };
    expect(brief.markdown).toContain("Morning brief");
    expect(brief.data).toBeDefined();
    const quiet = await tool("ops_set_quiet_hours").handler({ ws, actor: "user:test" }, { start: "22:00", end: "6:30" } as never);
    expect(quiet).toMatchObject({ quietHours: { start: "22:00", end: "06:30" } });
    const demo = await tool("ops_set_demo_mode").handler({ ws, actor: "user:test" }, { on: true } as never);
    expect(demo).toEqual({ demoMode: true });
    await expect(
      tool("ops_send_notification").handler({ ws, actor: "user:test" }, { text: "x", attachments: [{ path: "../secrets.txt" }] } as never),
    ).rejects.toThrow(/outside the workspace/);
  });
});

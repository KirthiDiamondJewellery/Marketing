import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideApproval, runMigrations } from "@attentionos/db";
import { confirmTrialProof } from "@attentionos/module-publishing";
import { NOW, seedContent, testDb, testWorkspace, type TestDb, type TestWs } from "../../publishing/test/helpers.ts";
import { BatchError, createBatch, getBatch, ledger, updateBatch, type BatchVariant } from "../src/repo.ts";
import { cancelBatch, scheduleBatch, SUBJECT } from "../src/service.ts";
import { tools } from "../src/tools/index.ts";

/**
 * Scheduling a day of trial reels against an in-memory publisher: dry run, the owner's OK, the one-time proof post,
 * the full day, re-runs that never double-post, the cap, cancelling, and the gates on making a batch. Rendering is
 * media-py's job (tested there); here the "rendered" files are small stand-ins with real hashes.
 */

let db: TestDb;
let dir: string;
beforeAll(async () => {
  db = await testDb("trial_reels");
  await runMigrations(db.sql, { moduleDirs: [
    { dir: fileURLToPath(new URL("../../publishing/migrations", import.meta.url)), source: "publishing" },
    { dir: fileURLToPath(new URL("../../community/migrations", import.meta.url)), source: "community" },
    { dir: fileURLToPath(new URL("../migrations", import.meta.url)), source: "trial-reels" },
  ] });
  dir = mkdtempSync(join(tmpdir(), "aos-trial-"));
});
afterAll(async () => {
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ACK = { acknowledgements: { trialReelsRisk: true } };
const TAGS = ["bookbinding", "notebooks", "handmade", "papercraft", "journaling", "stationery"];

async function seedEdit(ws: TestWs, opts: { keyword?: string | null } = {}): Promise<{ ref: string; contentId: string }> {
  const { contentId } = await seedContent(ws, { keyword: opts.keyword === undefined ? null : opts.keyword });
  const ref = `rf-${Math.floor(Math.random() * 1e6)}`;
  await ws.sql`insert into edit_jobs (workspace_id, content_id, ref, status, version, plan) values (${ws.id}, ${contentId}, ${ref}, 'approved', 1, '{}'::jsonb)`;
  return { ref, contentId };
}

/** Stands in for `trial-reels.make`: n "rendered" files with real hashes and a passing check. */
async function fakeRender(ws: TestWs, batchId: string, reels: string[], n: number): Promise<BatchVariant[]> {
  const variants: BatchVariant[] = [];
  const per = reels.map((_, i) => Math.floor(n / reels.length) + (i < n % reels.length ? 1 : 0));
  reels.forEach((reel, r) => {
    for (let i = 0; i < per[r]!; i++) {
      const id = `${reel}-${String(i + 1).padStart(2, "0")}`;
      const file = join(dir, `${batchId}-${id}.mp4`);
      writeFileSync(file, `video ${batchId} ${id}`);
      variants.push({
        id, reel, index: i, speed: 1.03 + i / 100, grade: "warm", captionStyle: "outline", titleStyle: "plain_caps", ctaStyle: "white_box",
        title: "Make a notebook last", postCaption: `#${TAGS.slice(0, 5).join(" #")}`, file, durationS: 30,
        sha256: createHash("sha256").update(`video ${batchId} ${id}`).digest("hex"),
      });
    }
  });
  await updateBatch(ws, batchId, {
    status: "ready", manifest: { variants }, verify: { ok: true, count: variants.length, failures: [], files: Object.fromEntries(variants.map((v) => [v.id, v.sha256!])) },
  });
  return variants;
}

const approve = async (ws: TestWs, ref: string) => decideApproval(ws.sql, ws.id, { refOrId: ref, decision: "approved", actor: "user:test" });

describe("scheduling a day of trial reels", () => {
  it("dry run → the owner's OK → one proof post → the full day, never twice", async () => {
    const ws = await testWorkspace(db.sql, { config: ACK });
    const { ref } = await seedEdit(ws);
    const batch = await createBatch(ws, { reels: [{ source: { kind: "edit", editRef: ref }, titles: ["Make a notebook last"], hashtags: TAGS }], createdBy: "user:test" });
    expect(batch.post_date).toBe("2026-10-15"); // tomorrow
    expect(batch.total).toBe(9);
    await fakeRender(ws, batch.id, [batch.sources[0]!.slug], 9);

    const dry = await scheduleBatch(ws, { batchId: batch.id, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.plan).toHaveLength(1); // no proof on this account yet: one, right away
    expect(dry.plan![0]!.at).toBeNull();
    expect(ws.fake.published).toHaveLength(0);

    // Without the owner's OK nothing goes out; an approval card is waiting.
    const waiting = await scheduleBatch(ws, { batchId: batch.id, dryRun: false, actor: "agent:publisher" });
    expect(waiting.ok).toBe(false);
    expect(waiting.approvalRef).toMatch(/^ap-\d+$/);
    expect(ws.fake.published).toHaveLength(0);
    await expect(decideApproval(ws.sql, ws.id, { refOrId: waiting.approvalRef!, decision: "approved", actor: "agent:publisher" })).rejects.toThrow(/person/);
    await approve(ws, waiting.approvalRef!);

    // First time on this account: exactly one trial reel, right away.
    const proof = await scheduleBatch(ws, { batchId: batch.id, dryRun: false, actor: "user:test" });
    expect(proof.proving).toBe(true);
    expect(ws.fake.published).toHaveLength(1);
    const first = ws.fake.published[0]!;
    expect(first.scheduledAt).toBeUndefined();
    expect(first.options?.instagram).toEqual({ trialReel: true, shareToFeed: false, trialGraduation: "MANUAL" });
    expect((await getBatch(ws, batch.id))!.status).toBe("proving");
    expect((await scheduleBatch(ws, { batchId: batch.id, dryRun: false })).proving).toBe(true);
    expect(ws.fake.published).toHaveLength(1);

    // The owner checks their grid and confirms; then the rest goes out across the day.
    const [posted] = await ledger(ws, batch.id);
    expect(await confirmTrialProof(ws, posted!.post_id!, "user:test")).toMatchObject({ ok: true });
    const full = await scheduleBatch(ws, { batchId: batch.id, dryRun: false, actor: "user:test" });
    expect(full.ok).toBe(true);
    expect(full.sent).toBe(8);
    expect(ws.fake.published).toHaveLength(9);
    const times = ws.fake.published.slice(1).map((p) => p.scheduledAt!);
    expect(times[0]).toBe("2026-10-15T12:00:00.000Z"); // 08:00 New York
    expect(times[7]).toBe("2026-10-16T01:00:00.000Z"); // 21:00 New York
    expect(ws.fake.published.every((p) => p.options?.instagram?.trialReel === true && p.options.instagram.shareToFeed === false)).toBe(true);
    expect(ws.fake.published.every((p) => (p.caption.match(/#\w+/g) ?? []).length === 5)).toBe(true);
    expect((await getBatch(ws, batch.id))!.status).toBe("scheduled");

    // Re-runs never send anything twice.
    await scheduleBatch(ws, { batchId: batch.id, dryRun: false });
    expect(ws.fake.published).toHaveLength(9);
    const rows = await ws.sql<{ n: number }[]>`select count(*)::int as n from posts where workspace_id = ${ws.id} and is_trial`;
    expect(rows[0]!.n).toBe(9);
    // The piece itself isn't moved along by its trial reels.
    const [c] = await ws.sql<{ status: string }[]>`select c.status from content c join edit_jobs e on e.content_id = c.id where e.ref = ${ref}`;
    expect(c!.status).toBe("review");

    // No second batch for the same video on the same day.
    await expect(createBatch(ws, { reels: [{ source: { kind: "edit", editRef: ref }, titles: ["Make a notebook last"], hashtags: TAGS }], createdBy: "user:test" })).rejects.toThrow(/already has trial reels scheduled/);

    // Cancel: the scheduled ones come off the publisher; the live proof post stays.
    const cancelled = await cancelBatch(ws, { batchId: batch.ref });
    expect(cancelled.cancelled).toBe(8);
    expect(ws.fake.cancelled).toHaveLength(8);
    expect((await ledger(ws, batch.id)).filter((l) => l.status === "cancelled")).toHaveLength(8);
  });

  it("splits the day across reels, alternating them, and stays under the 24-hour cap", async () => {
    const ws = await testWorkspace(db.sql, { config: { ...ACK, modules: { "trial-reels": { settings: { dailyCap: 12, graduation: "auto" } } } } });
    const a = await seedEdit(ws);
    const b = await seedEdit(ws);
    const batch = await createBatch(ws, {
      reels: [
        { source: { kind: "edit", editRef: a.ref }, titles: ["Make a notebook last", "A notebook: make it last"], hashtags: TAGS },
        { source: { kind: "edit", editRef: b.ref }, titles: ["Stitch a spine"], hashtags: TAGS, layout: "split-screen" },
      ],
      createdBy: "user:test",
    });
    const [ra, rb] = batch.sources.map((s) => s.slug);
    await fakeRender(ws, batch.id, [ra!, rb!], 9);
    // The account already has 5 posts that day: only 7 more fit under a cap of 12.
    const [acct] = await ws.sql<{ id: string }[]>`insert into social_accounts (workspace_id, provider, provider_account_id, platform, handle, status, updated_at)
      values (${ws.id}, 'fakepub', 'acct-ig', 'instagram', 'examplebrand.studio', 'connected', now()) returning id`;
    for (let i = 0; i < 5; i++) {
      await ws.sql`insert into posts (workspace_id, content_id, social_account_id, platform, provider, status, scheduled_at, idempotency_key)
        values (${ws.id}, ${a.contentId}, ${acct!.id}, 'instagram', 'fakepub', 'scheduled', ${new Date(Date.UTC(2026, 9, 15, 16 + i))}, ${`other-${i}`})`;
    }
    await ws.sql`insert into settings (workspace_id, key, value) values (${ws.id}, 'publishing.trial_reels.proof:acct-ig', ${ws.sql.json({ date: "2026-10-01", postId: "x" } as never)})`;
    const dry = await scheduleBatch(ws, { batchId: batch.id, dryRun: true });
    expect(dry.plan).toHaveLength(7);
    expect(dry.message).toMatch(/cap leaves room for 7/);
    const reelsInOrder = dry.plan!.map((p) => p.variantId.split("-").slice(0, -1).join("-"));
    expect(reelsInOrder.every((r, i) => i === 0 || r !== reelsInOrder[i - 1])).toBe(true);

    const pending = await scheduleBatch(ws, { batchId: batch.id, dryRun: false });
    await approve(ws, pending.approvalRef!);
    const res = await scheduleBatch(ws, { batchId: batch.id, dryRun: false });
    expect(res.sent).toBe(7);
    expect(ws.fake.published.every((p) => p.options?.instagram?.trialGraduation === "SS_PERFORMANCE")).toBe(true);
    expect((await getBatch(ws, batch.id))!.status).toBe("partial");
  });

  it("refuses files that changed after the check, a missing risk notice, and slots that already passed", async () => {
    const noAck = await testWorkspace(db.sql);
    const e0 = await seedEdit(noAck);
    const b0 = await createBatch(noAck, { reels: [{ source: { kind: "edit", editRef: e0.ref }, titles: [], hashtags: TAGS }], createdBy: "user:test" });
    await fakeRender(noAck, b0.id, [b0.sources[0]!.slug], 3);
    expect((await scheduleBatch(noAck, { batchId: b0.id, dryRun: true })).message).toMatch(/Before it can be scheduled: Trial reels need the platform-risk notice/);
    expect((await scheduleBatch(noAck, { batchId: b0.id, dryRun: false })).message).toMatch(/^Trial reels need the platform-risk notice/);

    const ws = await testWorkspace(db.sql, { config: ACK });
    const e = await seedEdit(ws);
    const batch = await createBatch(ws, { date: "2026-10-14", reels: [{ source: { kind: "edit", editRef: e.ref }, titles: ["Make a notebook last"], hashtags: TAGS }], createdBy: "user:test" });
    const variants = await fakeRender(ws, batch.id, [batch.sources[0]!.slug], 3);
    await ws.sql`insert into settings (workspace_id, key, value) values (${ws.id}, 'publishing.trial_reels.proof:acct-ig', ${ws.sql.json({ date: "2026-10-01", postId: "x" } as never)})`;
    ws.setNow(new Date("2026-10-14T11:00:00Z")); // 07:00 New York: the whole window is still ahead
    expect((await scheduleBatch(ws, { batchId: batch.id, dryRun: true })).message).toBe("Dry run: 3 trial reels on 2026-10-14, 08:00–21:00 America/New York, Instagram trial only, graduation manual. Nothing was sent.");
    ws.setNow(new Date("2026-10-14T15:00:00Z")); // 11:00 New York: the 08:00 slot has passed
    expect((await scheduleBatch(ws, { batchId: batch.id, dryRun: true })).message).toMatch(/1 slot on 2026-10-14 has already passed/);
    expect((await scheduleBatch(ws, { batchId: batch.id, dryRun: false })).ok).toBe(false);
    expect(await ws.sql`select 1 from approvals where workspace_id = ${ws.id} and subject_type = ${SUBJECT}`).toHaveLength(0);
    writeFileSync(variants[1]!.file, "edited");
    expect((await scheduleBatch(ws, { batchId: batch.id, dryRun: true })).message).toMatch(/changed after it was checked/);
    expect(ws.fake.published).toHaveLength(0);
    ws.setNow(NOW);
  });
});

describe("making a batch", () => {
  it("keeps to the owner's words, topic hashtags, the keyword and the daily cap", async () => {
    const ws = await testWorkspace(db.sql, { config: ACK });
    const e = await seedEdit(ws, { keyword: "stitch" });
    const make = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      createBatch(ws, { reels: [{ source: { kind: "edit", editRef: e.ref }, titles: ["Make a notebook last"], hashtags: TAGS, captionLine: "Comment STITCH for the guide", ...over }], createdBy: "user:test", ...extra });
    await expect(make({ titles: ["Make a notebook last", "The secret notebook hack"] })).rejects.toThrow(/secret, hack/);
    await expect(make({ hashtags: ["a", "b", "c"] })).rejects.toThrow(/at least 5 hashtags/);
    await expect(make({ captionLine: "Follow for more" })).rejects.toThrow(/keyword STITCH/);
    await expect(make({}, { total: 51 })).rejects.toThrow(BatchError);
    await expect(make({}, { date: "2026-10-13" })).rejects.toThrow(/already passed/);
    const ok = await make({ titles: ["Make a notebook last", "Notebook: make it last"] }, { total: 4 });
    expect(ok.sources[0]).toMatchObject({ titles: ["Make a notebook last", "Notebook: make it last"], captionLine: "Comment STITCH for the guide", layout: "talking-head" });
  });

  it("the agent tool queues the render and can't schedule without the owner", async () => {
    const ws = await testWorkspace(db.sql, { config: ACK });
    const e = await seedEdit(ws);
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const sources = (await tool("trial_reels_sources").handler({ ws, actor: "agent:chief_of_staff" }, { days: 14 } as never)) as { sources: { id: string }[] };
    expect(sources.sources.map((s) => s.id)).toContain(e.ref);
    const made = (await tool("trial_reels_make").handler({ ws, actor: "agent:chief_of_staff" }, tool("trial_reels_make").input.parse({ videos: [{ editRef: e.ref, title: "Make a notebook last", hashtags: TAGS }] }) as never)) as { ref: string };
    const [run] = await ws.sql<{ job_id: string }[]>`select job_id from agent_runs where workspace_id = ${ws.id} order by created_at desc limit 1`;
    expect(run!.job_id).toBe("trial-reels.make");
    expect(made.ref).toMatch(/^tr-\d+$/);
  });
});

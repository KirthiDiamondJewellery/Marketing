/**
 * The production chain on a real Postgres (own database: attentionos_test_production) with a fake publisher:
 * link (queue order by film-by, extra takes, swapping takes) → cut list skipped when review is off → proposed post
 * slots → approval rules → scheduling through the publishing module (Instagram assist, others scheduled with
 * utm_content) → autopilot. Editing's own jobs are simulated at the database level; they have their own tests.
 * Skips when Postgres isn't reachable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, silentLogger, type JobContext, type Sql, type WorkspaceContext } from "@attentionos/core";
import { decideApproval, enqueueRun, requestApproval } from "@attentionos/db";
import { createTestDatabase, hasTestDatabase, NEEDS_DB } from "@attentionos/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { CAPTIONS, FakePublisher, demoBrandKit } from "../../publishing/test/helpers.ts";
import { describeOutcomes, kickAdvance, linkUpload, mayRelease, runAdvance, runScheduleApproved } from "../src/index.ts";

const MIG = (m: string) => fileURLToPath(new URL(`../../${m}/migrations`, import.meta.url));
const NOW = new Date("2026-10-14T12:00:00Z"); // Wednesday, 08:00 in New York

/** Null (skip) only when Postgres is unreachable (under CI that throws instead); other setup errors fail the file. */
async function setUp(): Promise<{ sql: Sql; drop(): Promise<void> } | null> {
  if (!(await hasTestDatabase())) return null;
  return createTestDatabase("attentionos_test_production", {
    moduleDirs: [{ dir: MIG("publishing"), source: "publishing" }, { dir: MIG("production"), source: "production" }],
  });
}
const db = await setUp();

const root = mkdtempSync(join(tmpdir(), "aos-production-"));
mkdirSync(join(root, "media", "raw"), { recursive: true });
afterAll(async () => {
  await db?.drop();
  rmSync(root, { recursive: true, force: true });
});

async function workspace(sql: Sql, agents: Record<string, unknown> = {}): Promise<WorkspaceContext & { fake: FakePublisher }> {
  const [w] = await sql<{ id: string }[]>`insert into workspaces (name, slug, timezone) values ('Examplebrand Studio', ${`qf-${Math.random().toString(36).slice(2, 8)}`}, 'America/New_York') returning id`;
  const fake = new FakePublisher();
  const config = parseConfig({ workspace: { name: "Examplebrand Studio", timezone: "America/New_York" }, platforms: ["instagram", "tiktok", "youtube"], agents });
  const brand = demoBrandKit();
  return {
    id: w!.id,
    paths: { root, brand: join(root, "brand"), config: join(root, "config"), media: join(root, "media"), lessons: join(root, "brand/lessons.md"), state: join(root, ".attentionos") },
    config,
    brand: () => brand,
    reloadBrand: () => brand,
    sql,
    providers: { trendSources: {}, publisher: fake },
    log: silentLogger,
    now: () => NOW,
    secret: () => undefined,
    fake,
  };
}

async function script(ws: WorkspaceContext, title: string, filmBy: Date | null): Promise<string> {
  const [c] = await ws.sql<{ id: string }[]>`
    insert into content (workspace_id, title, status, kind, film_by, cta_type, template) values (${ws.id}, ${title}, 'filming', 'reel', ${filmBy}, 'follow', 'raw-talking-head') returning id`;
  await ws.sql`insert into scripts (workspace_id, content_id, version, body, hook_text, captions, status)
               values (${ws.id}, ${c!.id}, 1, ${`${title}. The body of the script.`}, ${title}, ${ws.sql.json(CAPTIONS as never)}, 'approved')`;
  return c!.id;
}

async function upload(ws: WorkspaceContext, name: string): Promise<string> {
  const path = join(root, "media", "raw", `${name}-${Math.random().toString(36).slice(2, 6)}.mp4`);
  writeFileSync(path, "fake video");
  const [a] = await ws.sql<{ id: string }[]>`insert into media_assets (workspace_id, kind, uri, license) values (${ws.id}, 'raw', ${path}, 'own footage') returning id`;
  const [u] = await ws.sql<{ id: string }[]>`insert into production_uploads (workspace_id, asset_id, file_name) values (${ws.id}, ${a!.id}, ${`${name}.mp4`}) returning id`;
  return u!.id;
}

async function ctx<I>(ws: WorkspaceContext, jobId: string, input: I): Promise<JobContext<I>> {
  const run = await enqueueRun(ws.sql, { workspaceId: ws.id, jobId, agent: "art_director", input: input as Record<string, unknown>, startRunningAs: "test" });
  return { ws, input, actor: "agent:art_director", runId: run.id, log: silentLogger, signal: new AbortController().signal, progress: async () => {} };
}

/** What editing.render leaves behind: v`version` rendered, a pending final-video approval. */
async function rendered(ws: WorkspaceContext, editId: string, version = 1): Promise<string> {
  const out = join(root, "media", `render-${editId}-v${version}.mp4`);
  writeFileSync(out, "fake render");
  const [e] = await ws.sql<{ content_id: string; ref: string }[]>`select content_id, ref from edit_jobs where id = ${editId}`;
  const [m] = await ws.sql<{ id: string }[]>`insert into media_assets (workspace_id, content_id, kind, uri, duration_s) values (${ws.id}, ${e!.content_id}, 'render', ${out}, 31) returning id`;
  await ws.sql`update edit_jobs set status = 'review', version = ${version}, output_asset_id = ${m!.id} where id = ${editId}`;
  const run = await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: "editing.render", agent: "art_director", input: { ref: e!.ref, version } });
  await ws.sql`update agent_runs set status = 'waiting_approval' where id = ${run.id}`;
  const { approval } = await requestApproval(ws.sql, ws.id, { kind: "edit", subjectType: "edit_render", subjectId: editId, agent: "art_director", summary: `${e!.ref} v${version} is ready`, runId: run.id });
  return approval.ref;
}

describe.runIf(db)(`production flow${NEEDS_DB}`, () => {
  it("links takes in film-by order, keeps extra takes and swaps a take in", async () => {
    const ws = await workspace(db!.sql);
    const later = await script(ws, "Paper we stopped buying", new Date("2026-10-20T22:00:00Z"));
    const sooner = await script(ws, "Notebooks break at the spine", new Date("2026-10-15T22:00:00Z"));
    const u1 = await upload(ws, "take-later");
    const u2 = await upload(ws, "take-sooner");
    const r1 = await linkUpload(ws, { uploadId: u1, contentId: later, actor: "user:studio" });
    const r2 = await linkUpload(ws, { uploadId: u2, contentId: sooner, actor: "auto", confidence: 0.91 });
    expect(r1.role).toBe("edit");
    expect(r2.ref).toMatch(/^rf-\d+$/);
    const runs = await ws.sql<{ input: { ref: string }; run_after: Date }[]>`
      select input, run_after from agent_runs where workspace_id = ${ws.id} and job_id = 'editing.prep' order by run_after, created_at`;
    expect(runs.map((r) => r.input.ref)).toEqual([r2.ref, r1.ref]); // sooner deadline first

    const [c] = await ws.sql<{ status: string }[]>`select status from content where id = ${sooner}`;
    expect(c!.status).toBe("editing");

    const u3 = await upload(ws, "take-sooner-2");
    const r3 = await linkUpload(ws, { uploadId: u3, contentId: sooner, actor: "user:studio" });
    expect(r3.role).toBe("take");
    expect(r3.message).toContain("another take");

    const r4 = await linkUpload(ws, { uploadId: u3, contentId: sooner, actor: "user:studio", replace: true });
    expect(r4.role).toBe("edit");
    const old = await ws.sql<{ status: string }[]>`select status from edit_jobs where workspace_id = ${ws.id} and ref = ${r2.ref}`;
    expect(old[0]!.status).toBe("cancelled");
    const [prev] = await ws.sql<{ role: string }[]>`select role from production_uploads where id = ${u2}`;
    expect(prev!.role).toBe("take");

    const none = await upload(ws, "b-roll-walkthrough");
    const r5 = await linkUpload(ws, { uploadId: none, contentId: null, actor: "user:studio" });
    expect(r5.title).toBe("b roll walkthrough");
  });

  it("skips the cut-list review when it's off, proposes slots and waits for a person", async () => {
    const ws = await workspace(db!.sql);
    const content = await script(ws, "Notebooks break at the spine", new Date("2026-10-15T22:00:00Z"));
    const up = await upload(ws, "take");
    const ref = (await linkUpload(ws, { uploadId: up, contentId: content, actor: "user:studio" })).ref!;
    const [e] = await ws.sql<{ id: string }[]>`select id from edit_jobs where workspace_id = ${ws.id} and ref = ${ref}`;
    // editing.prep finished and asked for the cut list.
    const [prep] = await ws.sql<{ id: string }[]>`select id from agent_runs where workspace_id = ${ws.id} and job_id = 'editing.prep' and input->>'ref' = ${ref}`;
    await ws.sql`update agent_runs set status = 'waiting_approval' where id = ${prep!.id}`;
    await ws.sql`update edit_jobs set status = 'review' where id = ${e!.id}`;
    const { approval: cut } = await requestApproval(ws.sql, ws.id, { kind: "edit", subjectType: "edit_map", subjectId: e!.id, agent: "art_director", summary: `${ref} cut list`, runId: prep!.id });

    const out = await runAdvance(await ctx(ws, "production.advance", {}));
    expect(out.steps).toContain(`${ref}: cuts approved (review is off)`);
    const [decided] = await ws.sql<{ status: string; decided_by: string }[]>`select status, decided_by from approvals where id = ${cut.id}`;
    expect(decided).toMatchObject({ status: "approved", decided_by: "system" });
    const [requeued] = await ws.sql<{ status: string; input: { approval?: { decision: string } } }[]>`select status, input from agent_runs where id = ${prep!.id}`;
    expect(requeued!.status).toBe("queued");
    expect(requeued!.input.approval?.decision).toBe("approved");
    // It keeps itself running while the edit is in flight.
    const [next] = await ws.sql<{ n: number }[]>`select count(*)::int as n from agent_runs where workspace_id = ${ws.id} and job_id = 'production.advance' and status = 'queued'`;
    expect(next!.n).toBeGreaterThan(0);

    // The video is rendered and waits for approval: slots are proposed, nothing is approved for the person.
    const apRef = await rendered(ws, e!.id);
    await runAdvance(await ctx(ws, "production.advance", {}));
    const [rel] = await ws.sql<{ status: string; slots: { platform: string; scheduledAt: string; mode: string }[] }[]>`
      select status, slots from production_releases where edit_job_id = ${e!.id} and version = 1`;
    expect(rel!.status).toBe("proposed");
    expect(rel!.slots.map((s) => s.platform).sort()).toEqual(["instagram", "tiktok", "youtube"]);
    expect(rel!.slots.find((s) => s.platform === "instagram")!.mode).toBe("assist");
    expect(rel!.slots.every((s) => Date.parse(s.scheduledAt) > NOW.getTime())).toBe(true);
    const [still] = await ws.sql<{ status: string }[]>`select status from approvals where workspace_id = ${ws.id} and ref = ${apRef}`;
    expect(still!.status).toBe("pending");

    // A second video waiting at the same time gets different slots.
    const content2 = await script(ws, "Paper we stopped buying", null);
    const up2 = await upload(ws, "take2");
    const second = await linkUpload(ws, { uploadId: up2, contentId: content2, actor: "user:studio" });
    const [e2] = await ws.sql<{ id: string }[]>`select id from edit_jobs where workspace_id = ${ws.id} and ref = ${second.ref}`;
    await rendered(ws, e2!.id);
    await runAdvance(await ctx(ws, "production.advance", {}));
    const [rel2] = await ws.sql<{ slots: { platform: string; scheduledAt: string }[] }[]>`select slots from production_releases where edit_job_id = ${e2!.id}`;
    const tt1 = rel!.slots.find((s) => s.platform === "tiktok")!.scheduledAt;
    const tt2 = rel2!.slots.find((s) => s.platform === "tiktok")!.scheduledAt;
    expect(tt2).not.toBe(tt1);

    // The schedule job refuses until a person approves.
    const refused = await runScheduleApproved(await ctx(ws, "production.schedule-approved", { ref }));
    expect(refused.scheduled).toBe(false);

    // A person approves the video (and with it the posting plan shown on the card).
    const planId = crypto.randomUUID();
    const { approval: plan } = await requestApproval(ws.sql, ws.id, { kind: "campaign", subjectType: "week_plan", subjectId: planId, agent: "publisher", summary: "Post it" });
    await decideApproval(ws.sql, ws.id, { refOrId: plan.ref, decision: "approved", actor: "user:studio" });
    await ws.sql`update production_releases set plan_id = ${planId}, captions = ${ws.sql.json({ tiktok: "Edited TikTok caption. DM me STITCH for the guide. #bookbinding" } as never)} where edit_job_id = ${e!.id}`;
    await decideApproval(ws.sql, ws.id, { refOrId: apRef, decision: "approved", actor: "user:studio" });
    const done = await runScheduleApproved(await ctx(ws, "production.schedule-approved", { ref }));
    expect(done.status, JSON.stringify(done.outcomes)).toBe("scheduled");
    const posts = await ws.sql<{ platform: string; status: string; caption: string; utm_content: string | null; scheduled_at: Date }[]>`
      select platform, status, caption, utm_content, scheduled_at from posts where workspace_id = ${ws.id} and content_id = ${content} order by platform`;
    expect(posts.map((p) => [p.platform, p.status])).toEqual([["instagram", "assist"], ["tiktok", "scheduled"], ["youtube", "scheduled"]]);
    expect(posts.find((p) => p.platform === "tiktok")!.caption).toContain("Edited TikTok caption");
    expect(posts.every((p) => p.utm_content)).toBe(true);
    expect(ws.fake.published).toHaveLength(2);
    expect(String(done.summary)).toMatch(/^Scheduled for \w{3} \d/);
    expect(String(done.summary)).toContain("Instagram (you post it)");

    // Running it again posts nothing twice.
    const again = await runScheduleApproved(await ctx(ws, "production.schedule-approved", { ref }));
    expect(again.already).toBe(true);
    expect(ws.fake.published).toHaveLength(2);
  });

  it("posts the captions the owner saw when the captions package doesn't pass the publishing schema", async () => {
    const ws = await workspace(db!.sql, { publisher: { autonomy: "autopilot" } });
    const content = await script(ws, "Older captions package", null);
    // Hand-written package: no hashtags on YouTube, an extra field on Instagram (the strict schema rejects it).
    await ws.sql`update scripts set captions = ${ws.sql.json({
      instagram: { caption: "Older captions package. Comment STITCH for the guide.", keyword: "STITCH", hashtags: ["#bookbinding", "#notebooks", "#handmade"] },
      youtube: { title: "Older captions package", description: "Free guide: link in bio." },
    } as never)} where content_id = ${content}`;
    const ref = (await linkUpload(ws, { uploadId: await upload(ws, "take"), contentId: content, actor: "user:studio" })).ref!;
    const [e] = await ws.sql<{ id: string }[]>`select id from edit_jobs where workspace_id = ${ws.id} and ref = ${ref}`;
    const apRef = await rendered(ws, e!.id);
    await runAdvance(await ctx(ws, "production.advance", {}));
    await decideApproval(ws.sql, ws.id, { refOrId: apRef, decision: "approved", actor: "user:studio" });
    const done = await runScheduleApproved(await ctx(ws, "production.schedule-approved", { ref }));
    expect(done.status, JSON.stringify(done.outcomes)).toBe("scheduled");
    const posts = await ws.sql<{ platform: string; caption: string; payload: { request: { options?: { youtube?: { title?: string } } } } }[]>`
      select platform, caption, payload from posts where workspace_id = ${ws.id} and content_id = ${content} order by platform`;
    expect(posts.map((p) => p.platform)).toEqual(["instagram", "youtube"]);
    expect(posts[0]!.caption).toBe("Older captions package. Comment STITCH for the guide.\n\n#bookbinding #notebooks #handmade");
    expect(posts[1]!.payload.request.options?.youtube?.title).toBe("Older captions package");
  });

  it("keeps the cut-list review when the owner turned it on", async () => {
    const ws = await workspace(db!.sql);
    await ws.sql`insert into settings (workspace_id, key, value) values (${ws.id}, 'production:settings', ${ws.sql.json({ reviewCuts: true } as never)})`;
    const content = await script(ws, "Workshop length", null);
    const { ref } = await linkUpload(ws, { uploadId: await upload(ws, "take"), contentId: content, actor: "user:studio" });
    const [e] = await ws.sql<{ id: string }[]>`select id from edit_jobs where workspace_id = ${ws.id} and ref = ${ref}`;
    await ws.sql`update edit_jobs set status = 'review' where id = ${e!.id}`;
    const { approval } = await requestApproval(ws.sql, ws.id, { kind: "edit", subjectType: "edit_map", subjectId: e!.id, agent: "art_director", summary: "cut list" });
    await runAdvance(await ctx(ws, "production.advance", {}));
    const [row] = await ws.sql<{ status: string }[]>`select status from approvals where id = ${approval.id}`;
    expect(row!.status).toBe("pending");
  });

  it("approves and schedules on its own only on autopilot", async () => {
    const ws = await workspace(db!.sql, { art_director: { autonomy: "autopilot" }, publisher: { autonomy: "autopilot" } });
    const content = await script(ws, "Autopilot piece", null);
    const ref = (await linkUpload(ws, { uploadId: await upload(ws, "take"), contentId: content, actor: "auto" })).ref!;
    const [e] = await ws.sql<{ id: string }[]>`select id from edit_jobs where workspace_id = ${ws.id} and ref = ${ref}`;
    const apRef = await rendered(ws, e!.id);
    const out = await runAdvance(await ctx(ws, "production.advance", {}));
    expect(out.steps).toContain(`${ref}: approved on autopilot`);
    const [ap] = await ws.sql<{ status: string; decided_by: string }[]>`select status, decided_by from approvals where workspace_id = ${ws.id} and ref = ${apRef}`;
    expect(ap).toMatchObject({ status: "approved", decided_by: "system" });
    const [queued] = await ws.sql<{ input: { ref: string } }[]>`select input from agent_runs where workspace_id = ${ws.id} and job_id = 'production.schedule-approved'`;
    expect(queued!.input.ref).toBe(ref);
    const done = await runScheduleApproved(await ctx(ws, "production.schedule-approved", { ref }));
    expect(done.status).toBe("scheduled");
    const [ev] = await ws.sql<{ message: string }[]>`select message from agent_events where workspace_id = ${ws.id} and agent = 'publisher' order by id desc limit 1`;
    expect(ev!.message).toContain("Autopilot piece");
  });

  it("only lets a person, or the system on autopilot, release a video", () => {
    const review = parseConfig({});
    const auto = parseConfig({ agents: { art_director: { autonomy: "autopilot" } } });
    const ap = (decided_by: string, status = "approved") => ({ ref: "ap-1", status, decided_by, decision_note: null });
    expect(mayRelease({ config: review }, ap("user:studio")).ok).toBe(true);
    expect(mayRelease({ config: review }, ap("system")).ok).toBe(false);
    expect(mayRelease({ config: auto }, ap("system")).ok).toBe(true);
    expect(mayRelease({ config: auto }, ap("user:studio", "revised")).ok).toBe(false);
    expect(mayRelease({ config: review }, undefined).ok).toBe(false);
  });

  it("describes outcomes in plain language", async () => {
    const ws = await workspace(db!.sql);
    const at = "2026-10-15T13:00:00.000Z"; // Thu 9:00 AM New York
    expect(describeOutcomes(ws, [
      { platform: "instagram", outcome: "assist", message: "", scheduledAt: at },
      { platform: "tiktok", outcome: "scheduled", message: "", scheduledAt: at },
    ])).toBe("Scheduled for Thu 9:00 AM on Instagram (you post it), TikTok");
    expect(describeOutcomes(ws, [{ platform: "youtube", outcome: "invalid", message: "No YouTube account is connected.\nConnect it" }])).toBe(
      "Nothing was scheduled. Not scheduled: YouTube (No YouTube account is connected.)",
    );
    await kickAdvance(ws);
  });
});

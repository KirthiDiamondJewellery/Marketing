import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "@attentionos/core";
import { decideApproval, requestApproval } from "@attentionos/db";
import {
  applyPublishEvent, cancelPost, crossPost, publishDue, schedulePost, scheduleWeek, confirmTrialProof, getTrialProof,
} from "../src/index.ts";
import { tools } from "../src/tools/index.ts";
import { NOW, seedContent, testDb, testWorkspace, type TestDb } from "./helpers.ts";

let db: TestDb;
beforeAll(async () => { db = await testDb("publishing"); });
afterAll(async () => { await db?.drop(); });

const MON_8 = "2026-10-19T12:00:00.000Z";
const messages = async (ws: { sql: TestDb["sql"]; id: string }) =>
  ws.sql<{ dedupe_key: string; body: { text: string; attachments?: { localPath: string }[] } }[]>`select dedupe_key, body from messages where workspace_id = ${ws.id} order by id`;

describe("schedulePost", () => {
  it("dry run validates and previews without writing or calling the publisher", async () => {
    const ws = await testWorkspace(db.sql);
    const { contentId } = await seedContent(ws);
    const o = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: true });
    expect(o.outcome).toBe("dry_run");
    expect(o.preview).toMatchObject({ platform: "tiktok", account: "@examplebrand.studio", mode: "auto", idempotencyKey: `post:${contentId}:tiktok:1` });
    expect(o.preview!.caption).toContain("DM me STITCH");
    const n = (await ws.sql<{ n: number }[]>`select count(*)::int as n from posts where workspace_id = ${ws.id}`)[0]!.n;
    expect(n).toBe(0);
    expect(ws.fake.published).toHaveLength(0);
    const [c] = await ws.sql<{ post_number: number | null }[]>`select post_number from content where id = ${contentId}`;
    expect(c!.post_number).toBeNull();
  });

  it("invalid payloads stop before any write", async () => {
    const ws = await testWorkspace(db.sql);
    const { contentId } = await seedContent(ws);
    const o = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false, captionOverride: "Comment STITCH below" });
    expect(o.outcome).toBe("invalid");
    expect(o.check.errors.map((e) => e.code)).toContain("publishing.tiktok_cta");
    const n = (await ws.sql<{ n: number }[]>`select count(*)::int as n from posts where workspace_id = ${ws.id}`)[0]!.n;
    expect(n).toBe(0);
  });

  it("review_all waits for a person's approval, then sends exactly once", async () => {
    const ws = await testWorkspace(db.sql);
    const { contentId } = await seedContent(ws);
    const first = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    expect(first.outcome).toBe("awaiting_approval");
    expect(first.approvalRef).toMatch(/^ap-\d+$/);
    expect(ws.fake.published).toHaveLength(0);
    const again = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    expect(again.approvalRef).toBe(first.approvalRef);

    await expect(decideApproval(ws.sql, ws.id, { refOrId: first.approvalRef!, decision: "approved", actor: "agent:publisher" })).rejects.toThrow(/Only a person/);
    await decideApproval(ws.sql, ws.id, { refOrId: first.approvalRef!, decision: "approved", actor: "user:test" });
    const due = await publishDue(ws);
    expect(due).toMatchObject({ approved: 1, sent: 1 });
    expect(ws.fake.published).toHaveLength(1);
    expect(ws.fake.published[0]).toMatchObject({ idempotencyKey: `post:${contentId}:tiktok:1`, accountId: "acct-tt", scheduledAt: MON_8, options: { tiktok: { privacy: "public", aiGenerated: false } } });

    const dup = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    expect(dup.outcome).toBe("already_exists");
    await publishDue(ws);
    expect(ws.fake.published).toHaveLength(1);

    const [post] = await ws.sql<{ status: string; provider_post_id: string; utm_content: string }[]>`select status, provider_post_id, utm_content from posts where id = ${first.postId!}`;
    expect(post).toMatchObject({ status: "scheduled", provider_post_id: "pp-1", utm_content: "stitch_1" });
    const [c] = await ws.sql<{ status: string; post_number: number }[]>`select status, post_number from content where id = ${contentId}`;
    expect(c).toEqual({ status: "scheduled", post_number: 1 });
  });

  it("autopilot sends straight away; review_key only holds key (bottom-of-funnel) posts", async () => {
    const auto = await testWorkspace(db.sql, { config: { agents: { publisher: { autonomy: "autopilot" } } } });
    const a = await seedContent(auto);
    expect((await schedulePost(auto, { contentId: a.contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false })).outcome).toBe("scheduled");

    const key = await testWorkspace(db.sql, { config: { agents: { publisher: { autonomy: "review_key" } } } });
    const tofu = await seedContent(key, { keyword: "folio" , captions: { tiktok: { caption: "A tip. DM me FOLIO.", hashtags: ["#bookbinding", "#notebooks", "#handmade"] } } });
    const bofu = await seedContent(key, { keyword: "workshop", funnelStage: "bofu", captions: { tiktok: { caption: "Book a seat. DM me WORKSHOP.", hashtags: ["#bookbinding", "#notebooks", "#handmade"] } } });
    expect((await schedulePost(key, { contentId: tofu.contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false })).outcome).toBe("scheduled");
    expect((await schedulePost(key, { contentId: bofu.contentId, platform: "tiktok", scheduledAt: "2026-10-20T12:00:00.000Z", dryRun: false })).outcome).toBe("awaiting_approval");
  });

  it("Instagram defaults to assist: no approval, no API call, a reminder with the file before the slot", async () => {
    const ws = await testWorkspace(db.sql);
    const { contentId } = await seedContent(ws);
    const o = await schedulePost(ws, { contentId, platform: "instagram", scheduledAt: MON_8, dryRun: false });
    expect(o.outcome).toBe("assist");
    expect((await publishDue(ws)).assistNotified).toBe(0);
    ws.setNow(new Date(Date.parse(MON_8) - 30 * 60_000));
    expect((await publishDue(ws)).assistNotified).toBe(1);
    expect((await publishDue(ws)).assistNotified).toBe(0);
    const msgs = await messages(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body.text).toContain("Comment STITCH");
    expect(msgs[0]!.body.attachments?.[0]?.localPath).toBe("/tmp/examplebrand/renders/notebook.mp4");
    expect(ws.fake.published).toHaveLength(0);

    const mark = tools.find((t) => t.name === "publishing_mark_posted")!;
    await mark.handler({ ws, actor: "user:test" }, { postId: o.postId!, url: "https://www.instagram.com/reel/QF0000demo/" } as never);
    const [p] = await ws.sql<{ status: string; url: string }[]>`select status, url from posts where id = ${o.postId!}`;
    expect(p).toEqual({ status: "published", url: "https://www.instagram.com/reel/QF0000demo/" });
  });

  it("with autopost on, Instagram goes through the normal approval path", async () => {
    const ws = await testWorkspace(db.sql, { config: { modules: { publishing: { settings: { instagram: { autopost: true } } } } } });
    const { contentId } = await seedContent(ws);
    expect((await schedulePost(ws, { contentId, platform: "instagram", scheduledAt: MON_8, dryRun: false })).outcome).toBe("awaiting_approval");
  });
});

describe("hand-off failures", () => {
  it("retries rate limits, never blindly resends ambiguous failures without idempotency, and recovers stale sends", async () => {
    const ws = await testWorkspace(db.sql, { config: { agents: { publisher: { autonomy: "autopilot" } } } });
    const one = await seedContent(ws, { keyword: "folio", captions: { tiktok: { caption: "DM me FOLIO", hashtags: ["#bookbinding", "#notebooks", "#handmade"] } } });
    ws.fake.failNext = new ProviderError("fakepub", "rate_limited", "slow down");
    expect((await schedulePost(ws, { contentId: one.contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false })).outcome).toBe("queued");
    expect((await publishDue(ws)).sent).toBe(1);

    ws.fake.supportsIdempotencyKeys = false;
    const two = await seedContent(ws, { keyword: "quire", captions: { tiktok: { caption: "DM me QUIRE", hashtags: ["#bookbinding", "#notebooks", "#handmade"] } } });
    ws.fake.failNext = new ProviderError("fakepub", "upstream", "socket hang up");
    const o = await schedulePost(ws, { contentId: two.contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    expect(o.outcome).toBe("failed");
    expect(o.message).toMatch(/may have been posted/);
    expect((await messages(ws)).some((m) => m.dedupe_key === `post-failed:${o.postId}`)).toBe(true);
    await publishDue(ws);
    expect(ws.fake.published).toHaveLength(1);

    const three = await seedContent(ws, { keyword: "signature", captions: { tiktok: { caption: "DM me SIGNATURE", hashtags: ["#bookbinding", "#notebooks", "#handmade"] } } });
    await ws.sql`
      insert into posts (workspace_id, content_id, platform, provider, status, scheduled_at, caption, idempotency_key, payload, updated_at)
      values (${ws.id}, ${three.contentId}, 'tiktok', 'fakepub', 'publishing', ${MON_8}, 'x', 'post:stale:tiktok:1',
              ${ws.sql.json({ request: { idempotencyKey: "post:stale:tiktok:1", accountId: "acct-tt", platform: "tiktok", caption: "x", media: [] }, mode: "auto", title: "Stale one" } as never)},
              ${new Date(NOW.getTime() - 20 * 60_000)})`;
    expect((await publishDue(ws)).recovered).toBe(1);
    const [stale] = await ws.sql<{ status: string; error: string }[]>`select status, error from posts where idempotency_key = 'post:stale:tiktok:1' and workspace_id = ${ws.id}`;
    expect(stale!.status).toBe("failed");
    expect(stale!.error).toMatch(/Check your fakepub calendar/);
  });

  it("a slot that passed long ago while waiting for approval fails with a plain reason instead of posting late", async () => {
    const ws = await testWorkspace(db.sql);
    const { contentId } = await seedContent(ws);
    const o = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    await decideApproval(ws.sql, ws.id, { refOrId: o.approvalRef!, decision: "approved", actor: "user:test" });
    ws.setNow(new Date(Date.parse(MON_8) + 5 * 3_600_000));
    expect((await publishDue(ws)).failed).toBe(1);
    const [p] = await ws.sql<{ status: string; error: string }[]>`select status, error from posts where id = ${o.postId!}`;
    expect(p!.error).toMatch(/passed while this post waited/);
  });
});

describe("events, refresh and cancel", () => {
  it("webhook events and polling move posts to published and the content with them", async () => {
    const ws = await testWorkspace(db.sql, { config: { agents: { publisher: { autonomy: "autopilot" } } } });
    const { contentId } = await seedContent(ws);
    const o = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    const touched = await applyPublishEvent(ws, {
      type: "post.published", providerPostId: "pp-1", idempotencyKey: `post:${contentId}:tiktok:1`,
      platforms: [{ platform: "tiktok", status: "published", platformPostId: "74000001", url: "https://www.tiktok.com/@examplebrand.studio/video/74000001" }],
    });
    expect(touched).toMatchObject({ id: o.postId, status: "published", platform_post_id: "74000001" });
    const [c] = await ws.sql<{ status: string }[]>`select status from content where id = ${contentId}`;
    expect(c!.status).toBe("published");
    expect(await applyPublishEvent(ws, { type: "post.published", providerPostId: "unknown" })).toBeUndefined();

    const two = await seedContent(ws, { keyword: "folio", captions: { tiktok: { caption: "DM me FOLIO", hashtags: ["#bookbinding", "#notebooks", "#handmade"] } } });
    const o2 = await schedulePost(ws, { contentId: two.contentId, platform: "tiktok", scheduledAt: "2026-10-20T12:00:00.000Z", dryRun: false });
    ws.fake.statuses.set("pp-2", { providerPostId: "pp-2", status: "failed" });
    ws.setNow(new Date("2026-10-20T12:10:00Z"));
    expect((await publishDue(ws)).refreshed).toBeGreaterThanOrEqual(1);
    const [p2] = await ws.sql<{ status: string }[]>`select status from posts where id = ${o2.postId!}`;
    expect(p2!.status).toBe("failed");
  });

  it("cancels scheduled posts at the provider and withdraws pending approvals", async () => {
    const ws = await testWorkspace(db.sql, { config: { agents: { publisher: { autonomy: "autopilot" } } } });
    const { contentId } = await seedContent(ws);
    const o = await schedulePost(ws, { contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    expect((await cancelPost(ws, o.postId!)).ok).toBe(true);
    expect(ws.fake.cancelled).toEqual(["pp-1"]);

    const ws2 = await testWorkspace(db.sql);
    const c2 = await seedContent(ws2);
    const pending = await schedulePost(ws2, { contentId: c2.contentId, platform: "tiktok", scheduledAt: MON_8, dryRun: false });
    await cancelPost(ws2, pending.postId!);
    const [a] = await ws2.sql<{ status: string }[]>`select status from approvals where ref = ${pending.approvalRef!} and workspace_id = ${ws2.id}`;
    expect(a!.status).toBe("expired");
  });
});

describe("week plan", () => {
  it("dry run plans without writing; confirm asks for ONE approval for the week; approval sends it", async () => {
    const ws = await testWorkspace(db.sql);
    await seedContent(ws, { title: "Piece one" });
    await seedContent(ws, { title: "Piece two", keyword: "folio", captions: { tiktok: { caption: "DM me FOLIO", hashtags: ["#bookbinding", "#notebooks", "#handmade"] }, instagram: { caption: "Comment FOLIO for the guide.", hashtags: ["#bookbinding"] } } });
    const dry = await scheduleWeek(ws, { dryRun: true });
    expect(dry.manifest.weekStart).toBe("2026-10-19");
    expect(dry.manifest.entries.filter((e) => e.platform === "tiktok")).toHaveLength(2);
    expect(dry.table).toContain("(you post)");
    expect(ws.fake.published).toHaveLength(0);

    const real = await scheduleWeek(ws, { dryRun: false });
    expect(real.approvalRef).toMatch(/^ap-/);
    const n = (await ws.sql<{ n: number }[]>`select count(*)::int as n from approvals where workspace_id = ${ws.id} and status = 'pending'`)[0]!.n;
    expect(n).toBe(1);
    expect(real.outcomes.filter((o) => o.outcome === "awaiting_approval").length).toBeGreaterThan(0);
    await decideApproval(ws.sql, ws.id, { refOrId: real.approvalRef!, decision: "approved", actor: "user:test" });
    const due = await publishDue(ws);
    expect(due.sent).toBe(real.outcomes.filter((o) => o.outcome === "awaiting_approval").length);
    // Re-running the plan is resumable: nothing new is created or sent.
    const rerun = await scheduleWeek(ws, { dryRun: false });
    expect(rerun.outcomes.every((o) => o.outcome === "already_exists")).toBe(true);
  });
});

describe("cross-post", () => {
  it("swaps the comment-keyword CTA for a tracked link off Instagram and uses open slots", async () => {
    const ws = await testWorkspace(db.sql, { config: { platforms: ["instagram", "tiktok", "youtube"] } });
    const { contentId } = await seedContent(ws, { captions: { instagram: { caption: "Make it last.\n\nComment STITCH and I'll send the guide.", hashtags: ["#bookbinding"] } } });
    const ig = await schedulePost(ws, { contentId, platform: "instagram", scheduledAt: MON_8, dryRun: false });
    const res = await crossPost(ws, { sourcePostId: ig.postId!, dryRun: true });
    const yt = res.outcomes.find((o) => o.platform === "youtube")!;
    const tt = res.outcomes.find((o) => o.platform === "tiktok")!;
    expect(yt.outcome).toBe("dry_run");
    expect(yt.preview!.caption).toMatch(/Get it here instead: https:\/\/examplebrand\.example\/\?utm_source=youtube&utm_medium=social&utm_campaign=organic&utm_content=stitch_1/);
    expect(tt.preview!.caption).toContain("link in bio");
    expect(tt.preview!.caption).not.toContain("Comment STITCH");
    expect(yt.preview!.scheduledAt).toBeDefined();
  });
});

describe("trial reels", () => {
  it("go out as trial reels only, wait for the batch approval, never move the piece along, and unlock after a person's check", async () => {
    const ws = await testWorkspace(db.sql, { config: { acknowledgements: { trialReelsRisk: true } } });
    const { contentId } = await seedContent(ws);
    const batchId = "6f1c2d3e-0000-4000-8000-000000000001";
    const input = {
      contentId, platform: "instagram" as const, scheduledAt: "2026-10-19T13:00:00Z", dryRun: false, captionOverride: "Comment STITCH and I'll send you the guide.  #bookbinding #notebooks #handmade #papercraft #journaling",
      media: { kind: "video" as const, localPath: "/tmp/examplebrand/trial-01.mp4", mimeType: "video/mp4" }, idempotencySuffix: "trial-2026-10-19-notebook-01",
      trial: { variation: 0, seed: "2026-10-19:notebook", variantOf: null }, planApproval: { subjectType: "trial_reel_batch", subjectId: batchId },
    };
    // No approval of the batch yet: nothing goes to the publisher.
    const { approval } = await requestApproval(ws.sql, ws.id, { kind: "post", subjectType: "trial_reel_batch", subjectId: batchId, agent: "publisher", summary: "Schedule 9 trial reels" });
    const waiting = await schedulePost(ws, input);
    expect(waiting.outcome, waiting.message).toBe("awaiting_approval");
    expect(ws.fake.published).toHaveLength(0);
    await decideApproval(ws.sql, ws.id, { refOrId: approval.ref, decision: "approved", actor: "user:test" });
    await ws.sql`update posts set status = 'cancelled' where id = ${waiting.postId!}`;
    const sent = await schedulePost(ws, input);
    expect(sent.outcome).toBe("scheduled");
    expect(ws.fake.published[0]!.options?.instagram).toEqual({ trialReel: true, shareToFeed: false, trialGraduation: "MANUAL" });
    const [c] = await ws.sql<{ status: string }[]>`select status from content where id = ${contentId}`;
    expect(c!.status).toBe("review");

    const auto = await schedulePost(ws, { ...input, idempotencySuffix: "trial-2026-10-19-notebook-02", trial: { ...input.trial, variation: 1, graduation: "SS_PERFORMANCE" as const } });
    expect(auto.outcome).toBe("scheduled");
    expect(ws.fake.published[1]!.options?.instagram?.trialGraduation).toBe("SS_PERFORMANCE");

    const postId = sent.postId!;
    expect((await confirmTrialProof(ws, postId, "user:test")).ok).toBe(false); // not live yet
    await ws.sql`update posts set status = 'published', url = 'https://social.example/reel/AbC123/' where id = ${postId}`;
    expect((await confirmTrialProof(ws, postId, "agent:publisher")).ok).toBe(false);
    expect((await confirmTrialProof(ws, postId, "user:test")).ok).toBe(true);
    expect(await getTrialProof(ws, "acct-ig")).toMatchObject({ postId, shortcode: "AbC123" });
  });
});

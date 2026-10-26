import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError, parseConfig, silentLogger, type PublishRequest } from "@attentionos/core";
import { assertH264Aac, blotatoWebhookRoute, buildPostBody, create, keywordVariants, retryAfterFromBody } from "../src/index.ts";
import { fakeFetch, fixture, noSleep, type Route } from "./fake-fetch.ts";

const FIX = join(import.meta.dirname, "fixtures");
const f = (name: string) => fixture(FIX, name);
const SID = "b7a1c2d3-0000-4000-8000-00000000demo";

function setup(routes: Route[], extra: Record<string, string> = {}) {
  const ff = fakeFetch(routes);
  const s = noSleep();
  const provider = create({
    secret: (n) => ({ BLOTATO_API_KEY: "demo-key-with-padding==", ...extra })[n],
    config: parseConfig({}),
    log: silentLogger,
    fetch: ff.fetch,
    sleep: s.sleep,
    now: () => new Date("2026-10-15T12:00:00Z"),
    probe: async () => ({ videoCodec: "h264", audioCodec: "aac" }),
  });
  return { provider, calls: ff.calls, sleeps: s.sleeps };
}

const reel: PublishRequest = {
  idempotencyKey: "post:0b9a3c55-8f0e-4d55-9d0f-2f7c9f6b1a01:instagram:1",
  accountId: "90001",
  platform: "instagram",
  caption: "Three ways to make a hand-bound notebook last. Comment STITCH and I'll send the guide.",
  media: [{ kind: "video", url: "https://cdn.example.com/examplebrand/notebook-reel.mp4" }],
  scheduledAt: "2026-10-14T08:00:00-04:00",
};

describe("blotato payloads", () => {
  it("puts scheduledTime at the payload ROOT (nested, Blotato ignores it and posts immediately)", () => {
    const body = buildPostBody(reel, ["https://cdn.example.com/examplebrand/notebook-reel.mp4"]);
    expect(body).toEqual({
      post: {
        accountId: "90001",
        content: { text: reel.caption, mediaUrls: ["https://cdn.example.com/examplebrand/notebook-reel.mp4"], platform: "instagram" },
        target: { targetType: "instagram", mediaType: "reel", shareToFeed: true },
      },
      scheduledTime: "2026-10-14T12:00:00.000Z",
    });
    expect((body.post as Record<string, unknown>).scheduledTime).toBeUndefined();
    expect(body.useNextFreeSlot).toBeUndefined();
  });

  it("encodes trial reels as `trial` and keeps them off the feed", () => {
    const body = buildPostBody({ ...reel, options: { instagram: { trialReel: true, collaborators: ["@demo_reader_3"] } } }, ["u"]);
    expect((body.post as { target: unknown }).target).toEqual({ targetType: "instagram", mediaType: "reel", collaborators: ["demo_reader_3"], trial: { graduationStrategy: "MANUAL" } });
  });

  it("sends all seven required TikTok fields", () => {
    const body = buildPostBody({ ...reel, platform: "tiktok", accountId: "90005", options: { tiktok: { aiGenerated: true, allowStitch: false } } }, ["u"]);
    expect((body.post as { target: unknown }).target).toEqual({
      targetType: "tiktok", privacyLevel: "PUBLIC_TO_EVERYONE", disabledComments: false, disabledDuet: false, disabledStitch: true,
      isBrandedContent: false, isYourBrand: false, isAiGenerated: true,
    });
  });

  it("maps X to twitter, Facebook pages from the composite account id, and requires a YouTube title", () => {
    const x = buildPostBody({ ...reel, platform: "x", accountId: "90002", media: [] }, []);
    expect(x.post).toMatchObject({ content: { platform: "twitter" }, target: { targetType: "twitter" } });
    const fb = buildPostBody({ ...reel, platform: "facebook", accountId: "90003/550000000000001" }, ["u"]);
    expect(fb.post).toMatchObject({ accountId: "90003", target: { targetType: "facebook", pageId: "550000000000001", mediaType: "reel" } });
    expect(() => buildPostBody({ ...reel, platform: "youtube" }, ["u"])).toThrow(/title/);
    const yt = buildPostBody({ ...reel, platform: "youtube", options: { youtube: { title: "Hand-bound notebooks" } } }, ["u"]);
    expect((yt.post as { target: unknown }).target).toEqual({ targetType: "youtube", title: "Hand-bound notebooks", privacyStatus: "public", shouldNotifySubscribers: true, isMadeForKids: false });
  });
});

describe("blotato publisher", () => {
  it("lists accounts, expanding Facebook into pages and skipping unsupported platforms", async () => {
    const { provider, calls } = setup([
      { method: "GET", match: "/v2/users/me/accounts", respond: { body: f("accounts.json") } },
      { method: "GET", match: "/v2/users/me/accounts/90003/subaccounts", respond: { body: f("subaccounts.json") } },
    ]);
    expect(await provider.listAccounts()).toEqual([
      { providerAccountId: "90001", platform: "instagram", handle: "examplebrand.studio", displayName: "Examplebrand Studio", status: "connected" },
      { providerAccountId: "90002", platform: "x", handle: "examplebrandstudio", displayName: "Examplebrand Studio", status: "connected" },
      { providerAccountId: "90003/550000000000001", platform: "facebook", handle: "Examplebrand Studio", displayName: "Examplebrand Studio", status: "connected" },
    ]);
    // Own header, no Bearer, and the key's trailing '=' is preserved.
    expect(calls[0]!.headers["blotato-api-key"]).toBe("demo-key-with-padding==");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("returns the SUBMISSION id, spaces posts 2.5 s apart and never double-submits the same key", async () => {
    const { provider, calls, sleeps } = setup([{ method: "POST", match: "/v2/posts", respond: { status: 201, body: f("post-created.json") } }]);
    const a = await provider.publish(reel);
    expect(a).toEqual({ providerPostId: SID, status: "scheduled", scheduledAt: "2026-10-14T12:00:00Z" });
    const again = await provider.publish(reel);
    expect(again).toBe(a);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await provider.publish({ ...reel, idempotencyKey: "post:other:instagram:1" });
    expect(sleeps.some((ms) => ms > 2_000 && ms <= 2_500)).toBe(true);
  });

  it("does not retry a failed post create (Blotato has no idempotency key)", async () => {
    const { provider, calls } = setup([{ method: "POST", match: "/v2/posts", respond: { status: 502, body: { message: "bad gateway" } } }]);
    await expect(provider.publish(reel)).rejects.toMatchObject({ code: "upstream" });
    expect(calls).toHaveLength(1);
    expect(provider.supportsIdempotencyKeys).toBe(false);
  });

  it("retries a post create only when Blotato refused it (429)", async () => {
    const { provider, calls, sleeps } = setup([{ method: "POST", match: "/v2/posts", respond: [{ status: 429, body: f("error-rate.json") }, { status: 201, body: f("post-created.json") }] }]);
    expect((await provider.publish(reel)).providerPostId).toBe(SID);
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(49_000);
  });

  it("maps submission status, including failures and the in-progress fallback", async () => {
    const { provider } = setup([
      { method: "GET", match: `/v2/posts/${SID}`, respond: { body: f("status-published.json") } },
      { method: "GET", match: "/v2/posts/fail", respond: { body: f("status-failed.json") } },
      { method: "GET", match: "/v2/posts/unknown", respond: { body: f("status-unknown.json") } },
    ]);
    expect(await provider.getPost(SID)).toEqual({ providerPostId: SID, status: "published", url: "https://www.instagram.com/reel/QF0000demo/" });
    expect(await provider.getPost("fail")).toEqual({ providerPostId: "fail", status: "failed", error: "Unsupported media type" });
    expect(await provider.getPost("unknown")).toEqual({ providerPostId: "unknown", status: "publishing" });
  });

  it("waits as long as the 429 message says, then retries reads", async () => {
    expect(retryAfterFromBody(f("error-rate.json"))).toBe(49_000);
    const { provider, sleeps } = setup([{ method: "GET", match: `/v2/posts/${SID}`, respond: [{ status: 429, body: f("error-rate.json") }, { body: f("status-published.json") }] }]);
    await provider.getPost(SID);
    expect(sleeps).toContain(49_000);
  });

  it("cancels by schedule id (not the submission id) with no JSON body", async () => {
    const { provider, calls } = setup([
      { method: "GET", match: `/v2/posts/${SID}`, respond: { body: f("status-scheduled.json") } },
      { method: "GET", match: "/v2/schedules", respond: { body: { items: [{ id: "sch_demo1", scheduledAt: "2026-10-14T12:00:00.000Z" }, { id: "sch_demo2", scheduledAt: "2026-10-15T12:00:00.000Z" }] } } },
      { method: "DELETE", match: "/v2/schedules/sch_demo1", respond: { status: 204 } },
    ]);
    await provider.cancel(SID);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/v2/schedules/sch_demo1");
    expect(del.headers["content-type"]).toBeUndefined();
  });

  it("is truthful about capabilities", () => {
    const { provider } = setup([]);
    expect(provider.capabilities()).toEqual({
      platforms: ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads"],
      scheduling: true, instagramTrialReels: true, instagramCollaborators: true, firstComment: true, maxVideoBytes: 400 * 1024 * 1024,
    });
  });
});

describe("blotato comment-to-DM", () => {
  const flowRoutes: Route[] = [
    { method: "GET", match: `/v2/posts/${SID}`, respond: { body: f("status-published.json") } },
    { method: "GET", match: "/v2/posts", respond: { body: f("published-posts.json") } },
    { method: "POST", match: "/v2/dm-automations", respond: { status: 201, body: f("flow-created.json") } },
  ];

  it("resolves the submission id to the PUBLISHED post id and sends case variants with a follow gate", async () => {
    const { provider, calls } = setup(flowRoutes);
    const res = await provider.createDmAutomation({
      accountId: "90001", platform: "instagram", providerPostId: SID, keyword: "stitch", matchMode: "exact_word",
      dmText: "Here's the stitching guide.", buttons: [{ label: "Get the guide", url: "https://examplebrand.example/guide/stitch" }], requireFollow: true,
    });
    expect(res).toEqual({ id: "flow_qf_1", keyword: "stitch", providerPostId: "771001", active: true });
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      accountId: "90001", platform: "instagram", target: { targetType: "instagram" },
      triggers: [{ type: "comment-received", keywords: ["stitch", "Stitch", "STITCH"], postId: "771001" }],
      dmMessage: "Here's the stitching guide.",
      buttons: [{ type: "url", title: "Get the guide", url: "https://examplebrand.example/guide/stitch" }],
      followGate: { buttonTitle: "I'm following" },
      isActive: true,
    });
  });

  it("finds natively uploaded posts through synced comments, and explains when there are none yet", async () => {
    const { provider } = setup([
      { method: "GET", match: "/v2/posts/18000000000000077", respond: { body: f("status-unknown.json") } },
      { method: "GET", match: "/v2/published-posts/18000000000000077", respond: { status: 404, body: { code: 404, message: "not found" } } },
      { method: "GET", match: "/v2/comments", respond: { body: f("comments.json") } },
    ]);
    expect(await provider.resolvePublishedPostId("18000000000000077", { accountId: "90001", platform: "instagram" })).toBe("771999");
    const { provider: p2 } = setup([
      { method: "GET", match: "/v2/posts/18000000000000099", respond: { body: f("status-unknown.json") } },
      { method: "GET", match: "/v2/published-posts/18000000000000099", respond: { status: 404, body: { message: "not found" } } },
      { method: "GET", match: "/v2/comments", respond: { body: { items: [] } } },
    ]);
    await expect(p2.resolvePublishedPostId("18000000000000099")).rejects.toThrow(/first comment syncs/);
  });

  it("refuses unscheduled scope, unpublished posts and Facebook follow gates", async () => {
    const { provider } = setup([{ method: "GET", match: `/v2/posts/${SID}`, respond: { body: f("status-scheduled.json") } }]);
    await expect(provider.createDmAutomation({ accountId: "90001", platform: "instagram", providerPostId: SID, keyword: "stitch", matchMode: "contains", dmText: "x" }))
      .rejects.toThrow(/isn't published yet/);
    await expect(provider.createDmAutomation({ accountId: "90001", platform: "instagram", providerPostId: null, keyword: "stitch", matchMode: "contains", dmText: "x" }))
      .rejects.toThrow(/scoped to one post/);
    await expect(provider.createDmAutomation({ accountId: "90003/1", platform: "facebook", providerPostId: SID, keyword: "stitch", matchMode: "contains", dmText: "x", requireFollow: true }))
      .rejects.toThrow(/only works on Instagram/);
    await expect(provider.createDmAutomation({ accountId: "90001", platform: "instagram", providerPostId: SID, keyword: "stitch", matchMode: "contains", dmText: "x", buttons: [{ label: "This label is far too long", url: "https://x.example" }] }))
      .rejects.toThrow(/over 20 characters/);
  });

  it("maps error 30101 (another DM tool on the account) to a conflict with a plain fix", async () => {
    const { provider } = setup([...flowRoutes.slice(0, 2), { method: "POST", match: "/v2/dm-automations", respond: { status: 400, body: f("error-30101.json") } }]);
    const err = await provider.createDmAutomation({ accountId: "90001", platform: "instagram", providerPostId: SID, keyword: "stitch", matchMode: "contains", dmText: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("conflict");
    expect((err as ProviderError).message).toMatch(/Another DM tool/);
    expect((err as ProviderError).details?.vendorCode).toBe(30101);
  });

  it("lists automations for one account and lists comments without our own", async () => {
    const { provider } = setup([
      { method: "GET", match: "/v2/dm-automations", respond: { body: f("flows.json") } },
      { method: "GET", match: "/v2/comments", respond: { body: f("comments.json") } },
    ]);
    expect(await provider.listDmAutomations("90001")).toEqual([{ id: "flow_qf_1", keyword: "stitch", providerPostId: "771001", active: true }]);
    const comments = await provider.listComments("771999");
    expect(comments).toEqual([{ id: "c-1", providerPostId: "771999", platform: "instagram", from: { id: "17841400000000888", handle: "demo_reader_3" }, text: "stitch", at: "2026-10-14T12:30:00Z" }]);
  });

  it("keyword variants", () => {
    expect(keywordVariants("Stitch")).toEqual(["stitch", "Stitch", "STITCH"]);
  });
});

describe("blotato lead webhook (minimal payload)", () => {
  const extra = { BLOTATO_WEBHOOK_URL: "https://tunnel.examplebrand.example/webhooks/blotato", BLOTATO_WEBHOOK_SECRET: "demo-webhook-secret-123" };

  it("asks Blotato to send our secret, keyword and post as headers, since the body is only {email, isFollower}", async () => {
    const { provider, calls } = setup([
      { method: "GET", match: `/v2/posts/${SID}`, respond: { body: f("status-published.json") } },
      { method: "GET", match: "/v2/posts", respond: { body: f("published-posts.json") } },
      { method: "POST", match: "/v2/dm-automations", respond: { status: 201, body: f("flow-created.json") } },
    ], extra);
    await provider.createDmAutomation({ accountId: "90001", platform: "instagram", providerPostId: SID, keyword: "Stitch", matchMode: "exact_word", dmText: "Here you go." });
    const body = calls.find((c) => c.method === "POST")!.body as { webhook: unknown };
    expect(body.webhook).toEqual({
      method: "POST", url: extra.BLOTATO_WEBHOOK_URL,
      headers: { "x-attentionos-secret": extra.BLOTATO_WEBHOOK_SECRET, "x-attentionos-keyword": "stitch", "x-attentionos-post": "771001" },
    });
  });

  it("verifies the shared header and routes emails to community.lead-captured", () => {
    const { provider } = setup([], extra);
    const req = { headers: { "x-attentionos-secret": extra.BLOTATO_WEBHOOK_SECRET, "x-attentionos-keyword": "stitch", "x-attentionos-post": "771001" }, body: "{}" };
    expect(provider.verifyWebhook(req)).toBe(true);
    expect(provider.verifyWebhook({ ...req, headers: { "x-attentionos-secret": "wrong" } })).toBe(false);
    expect(setup([]).provider.verifyWebhook(req)).toBe(false);
    expect(provider.webhookJob({ email: "Reader@Examplebrand.example", isFollower: true }, req)).toEqual({
      jobId: "community.lead-captured",
      input: { email: "reader@examplebrand.example", isFollower: true, keyword: "stitch", postRef: "771001", source: "instagram keyword DM" },
      dedupeKey: "blotato:lead:stitch:reader@examplebrand.example",
    });
    expect(blotatoWebhookRoute({ email: null, isFollower: false }, req)).toBeNull();
  });
});

describe("blotato analytics", () => {
  it("covers Blotato-published posts only, converts string counts and skips LinkedIn", async () => {
    const { provider } = setup([{ method: "GET", match: "/v2/posts", respond: { body: f("published-posts.json") } }]);
    const rows = await provider.listPostMetrics("90001");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platformPostId: "771001", platform: "instagram", url: "https://www.instagram.com/reel/QF0000demo/", capturedAt: "2026-10-15T12:00:00.000Z",
      views: 9100, reach: 4100, likes: 320, comments: 58, shares: 21, saves: 44, follows: 6, avgWatchTimeS: 6.4,
    });
  });
});

describe("video compatibility", () => {
  it("accepts H.264/AAC and silent H.264, refuses anything else, and doesn't block when ffprobe is missing", async () => {
    await expect(assertH264Aac("blotato", "/tmp/demo.mp4", async () => ({ videoCodec: "h264", audioCodec: "aac" }))).resolves.toBe("ok");
    await expect(assertH264Aac("blotato", "/tmp/demo.mp4", async () => ({ videoCodec: "h264" }))).resolves.toBe("ok");
    await expect(assertH264Aac("blotato", "/tmp/demo.mp4", async () => ({ videoCodec: "vp9", audioCodec: "opus" }))).rejects.toThrow(/H\.264/);
    await expect(assertH264Aac("blotato", "/tmp/demo.mp4", async () => undefined)).resolves.toBe("unchecked");
    await expect(assertH264Aac("blotato", "/tmp/cover.jpg", async () => ({ videoCodec: "mjpeg" }))).resolves.toBe("ok");
  });
});

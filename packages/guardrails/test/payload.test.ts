import type { PublisherCapabilities, PublishRequest, SocialAccount } from "@attentionos/core";
import { describe, expect, it } from "vitest";
import { validatePublishPayload } from "../src/index.ts";
import { codes, warnCodes } from "./fixtures.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const accounts: SocialAccount[] = [
  { providerAccountId: "acc-ig", platform: "instagram", handle: "examplebrandstudio", status: "connected" },
  { providerAccountId: "acc-tt", platform: "tiktok", handle: "examplebrandstudio", status: "connected" },
  { providerAccountId: "acc-yt", platform: "youtube", handle: "examplebrandstudio", status: "connected" },
  { providerAccountId: "acc-x", platform: "x", handle: "examplebrand", status: "connected" },
  { providerAccountId: "acc-li", platform: "linkedin", handle: "jordan-vale", status: "expired" },
];
const caps: PublisherCapabilities = {
  platforms: ["instagram", "tiktok", "youtube", "x", "linkedin", "facebook"],
  scheduling: true,
  instagramTrialReels: true,
  instagramCollaborators: false,
  firstComment: true,
  maxVideoBytes: 300_000_000,
};
const video = { kind: "video" as const, url: "https://cdn.example.com/reel.mp4", mimeType: "video/mp4", durationS: 42 };

const ig = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  idempotencyKey: "content-1:instagram:v1",
  accountId: "acc-ig",
  platform: "instagram",
  caption: "Budgets break early. Comment BLUEPRINT.",
  media: [video],
  scheduledAt: "2026-10-16T14:00:00Z",
  options: { instagram: { shareToFeed: true } },
  ...over,
});

describe("validatePublishPayload", () => {
  const cases: [string, PublishRequest, Parameters<typeof validatePublishPayload>[3], string[]][] = [
    ["valid instagram", ig(), {}, []],
    ["publish now (no schedule)", ig({ scheduledAt: undefined }), {}, []],
    ["missing idempotency key", ig({ idempotencyKey: "" }), {}, ["payload.idempotency_missing"]],
    ["bad idempotency key", ig({ idempotencyKey: "a b" }), {}, ["payload.idempotency_format"]],
    ["unknown account", ig({ accountId: "nope" }), {}, ["payload.account_missing"]],
    ["expired account", { ...ig(), accountId: "acc-li", platform: "linkedin", options: {} }, {}, ["payload.account_not_connected"]],
    ["platform mismatch", ig({ accountId: "acc-tt" }), {}, ["payload.platform_mismatch"]],
    ["unsupported platform", { ...ig(), platform: "threads", accountId: "acc-th", options: {} }, {}, ["payload.account_missing", "payload.platform_unsupported"]],
    ["IG without media", ig({ media: [] }), {}, ["payload.media_missing"]],
    ["media without source", ig({ media: [{ kind: "video" }] }), {}, ["payload.media_no_source"]],
    ["http media", ig({ media: [{ ...video, url: "http://cdn.example.com/a.mp4" }] }), {}, ["payload.media_url"]],
    ["wrong mime", ig({ media: [{ ...video, mimeType: "video/x-msvideo" }] }), {}, ["payload.media_type"]],
    ["too short", ig({ media: [{ ...video, durationS: 2 }] }), {}, ["payload.video_too_short"]],
    ["two videos", ig({ media: [video, video] }), {}, ["payload.too_many_videos"]],
    ["video too big", ig(), { mediaBytes: () => 400_000_000 }, ["payload.video_too_big"]],
    ["schedule in the past", ig({ scheduledAt: "2026-10-15T11:00:00Z" }), {}, ["payload.schedule_past"]],
    ["schedule too soon", ig({ scheduledAt: "2026-10-15T12:01:00Z" }), {}, ["payload.schedule_past"]],
    ["schedule without zone", ig({ scheduledAt: "2026-10-16T14:00:00" }), {}, ["payload.schedule_format"]],
    ["caption too long", ig({ caption: "a".repeat(2201) }), {}, ["payload.caption_too_long"]],
    ["trial reel unacknowledged", ig({ options: { instagram: { trialReel: true } } }), {}, ["payload.trial_reel_not_acknowledged"]],
    ["trial reel acknowledged", ig({ options: { instagram: { trialReel: true } } }), { acknowledgements: { trialReelsRisk: true } }, []],
    ["collaborators unsupported", ig({ options: { instagram: { collaborators: ["someone"] } } }), {}, ["payload.collaborators_unsupported"]],
    [
      "youtube needs title",
      { idempotencyKey: "content-1:youtube:v1", accountId: "acc-yt", platform: "youtube", caption: "Desc", media: [video], options: { youtube: { madeForKids: false } } },
      {},
      ["payload.youtube_title_missing"],
    ],
    [
      "youtube title 100",
      { idempotencyKey: "content-1:youtube:v1", accountId: "acc-yt", platform: "youtube", caption: "Desc", media: [video], options: { youtube: { title: "t".repeat(100), madeForKids: false } } },
      {},
      ["payload.youtube_title_length"],
    ],
    [
      "youtube short too long",
      { idempotencyKey: "content-1:youtube:v1", accountId: "acc-yt", platform: "youtube", caption: "Desc", media: [{ ...video, durationS: 200 }], options: { youtube: { title: "T", madeForKids: false } } },
      {},
      ["payload.video_too_long"],
    ],
    [
      "tiktok needs privacy",
      { idempotencyKey: "content-1:tiktok:v1", accountId: "acc-tt", platform: "tiktok", caption: "DM me BLUEPRINT", media: [video], options: { tiktok: { aiGenerated: false } } },
      {},
      ["payload.tiktok_privacy_missing"],
    ],
    [
      "x text only over limit",
      { idempotencyKey: "content-1:x:v1", accountId: "acc-x", platform: "x", caption: "a".repeat(281), media: [] },
      {},
      ["payload.caption_too_long"],
    ],
    [
      "x mixed media",
      { idempotencyKey: "content-1:x:v1", accountId: "acc-x", platform: "x", caption: "hi", media: [video, { kind: "image", url: "https://cdn.example.com/a.png", mimeType: "image/png" }] },
      {},
      ["payload.mixed_media"],
    ],
  ];

  it.each(cases)("%s", (_name, req, opts, expected) => {
    const r = validatePublishPayload(req, accounts, caps, { now: NOW, ...opts });
    expect(codes(r)).toEqual(expected);
  });

  it("scheduling unsupported by the provider", () => {
    const r = validatePublishPayload(ig(), accounts, { ...caps, scheduling: false }, { now: NOW });
    expect(codes(r)).toEqual(["payload.scheduling_unsupported"]);
  });

  it("warns about options for another platform and missing labels", () => {
    const r = validatePublishPayload(
      { idempotencyKey: "content-1:tiktok:v1", accountId: "acc-tt", platform: "tiktok", caption: "x", media: [video], options: { tiktok: { privacy: "public" }, instagram: {} } },
      accounts,
      caps,
      { now: NOW },
    );
    expect(r.ok).toBe(true);
    expect(warnCodes(r)).toEqual(["payload.tiktok_ai_label", "payload.foreign_options"]);
  });
});

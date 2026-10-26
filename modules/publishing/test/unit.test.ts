import { describe, expect, it } from "vitest";
import type { PublisherCapabilities, PublishRequest, SocialAccount } from "@attentionos/core";
import {
  buildTrackedUrl, buildUtm, buildUtmContent, buildWeekManifest, checkPayload, createShortLink, isKeywordCtaLine, planSlots,
  postIdempotencyKey, postNumberFromUtm, publishingSettingsSchema, swapKeywordCta, zonedToUtc,
  localDate, localTime, nextMonday,
} from "../src/index.ts";

const TZ = "America/New_York";
const NOW = new Date("2026-10-14T12:00:00Z"); // Wed 08:00 New York
const settings = publishingSettingsSchema.parse({});

describe("time", () => {
  it("converts local slots to UTC across DST", () => {
    expect(zonedToUtc("2026-10-19", "08:00", TZ).toISOString()).toBe("2026-10-19T12:00:00.000Z"); // EDT
    expect(zonedToUtc("2026-11-02", "08:00", TZ).toISOString()).toBe("2026-11-02T13:00:00.000Z"); // EST after Nov 1
    expect(localDate(new Date("2026-10-19T03:30:00Z"), TZ)).toBe("2026-10-18");
    expect(localTime(new Date("2026-10-19T12:00:00Z"), TZ)).toBe("08:00");
    expect(nextMonday(NOW, TZ)).toBe("2026-10-19");
  });
});

describe("tracked links", () => {
  it("builds utm_content as <prefix><keyword>_<post#>", () => {
    expect(buildUtmContent({ keyword: "STITCH", postNumber: 12 })).toBe("stitch_12");
    expect(buildUtmContent({ prefix: "qf-", keyword: "stitch", postNumber: 12 })).toBe("qf-stitch_12");
    expect(buildUtmContent({ keyword: null, postNumber: 3 })).toBe("post_3");
    expect(() => buildUtmContent({ keyword: "x", postNumber: 0 })).toThrow();
    expect(postNumberFromUtm("qf-stitch_12")).toBe(12);
  });

  it("adds UTM params, replacing existing ones", () => {
    const url = buildTrackedUrl("https://examplebrand.example/guide/stitch?utm_source=old&ref=a", buildUtm({ platform: "tiktok", medium: "social", campaign: "organic", content: "stitch_12" }));
    const u = new URL(url);
    expect(u.searchParams.get("utm_source")).toBe("tiktok");
    expect(u.searchParams.get("utm_content")).toBe("stitch_12");
    expect(u.searchParams.get("ref")).toBe("a");
  });

  it("calls the site's link API with the documented body and bearer token", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const short = await createShortLink({
      siteUrl: "https://examplebrand.example", apiPath: "/api/links", token: "demo-token", destination: "https://examplebrand.example/guide/stitch",
      utm: buildUtm({ platform: "instagram", medium: "social", campaign: "organic", content: "stitch_12" }), label: "Make a notebook last", creator: "examplebrand",
      fetch: async (url, init) => {
        seen = { url, init: init! };
        return new Response(JSON.stringify({ slug: "st12", shortUrl: "https://examplebrand.example/l/st12", fullUrl: "https://examplebrand.example/guide/stitch?utm_content=stitch_12" }), { status: 201 });
      },
    });
    expect(short.shortUrl).toBe("https://examplebrand.example/l/st12");
    expect(seen!.url).toBe("https://examplebrand.example/api/links");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer demo-token");
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      destination: "https://examplebrand.example/guide/stitch", creator: "examplebrand", label: "Make a notebook last",
      utm: { utm_source: "instagram", utm_medium: "social", utm_campaign: "organic", utm_content: "stitch_12" },
    });
    await expect(createShortLink({ siteUrl: "https://examplebrand.example", apiPath: "/api/links", token: "bad", destination: "https://examplebrand.example", utm: buildUtm({ platform: "x", medium: "m", campaign: "c", content: "d" }), label: "l", fetch: async () => new Response("no", { status: 401 }) }))
      .rejects.toThrow(/link token/);
  });
});

describe("week manifest", () => {
  const accounts = [
    { platform: "instagram" as const, providerAccountId: "acct-ig", handle: "examplebrand.studio" },
    { platform: "tiktok" as const, providerAccountId: "acct-tt", handle: "examplebrand.studio" },
  ];
  const items = Array.from({ length: 8 }, (_, i) => ({ contentId: `c${i + 1}`, title: `Piece ${i + 1}`, version: 2 }));
  const base = {
    weekStart: "2026-10-19", timezone: TZ, cadence: settings.cadence, accounts, supportedPlatforms: ["instagram", "tiktok", "youtube"] as const,
    enabledPlatforms: ["instagram", "tiktok", "youtube", "linkedin"] as const, items, taken: [], now: NOW, leadMinutes: 15, instagramAutopost: false,
  };

  it("spreads posts one per day at the best slot, respects perWeek and marks Instagram as assist", () => {
    const m = buildWeekManifest({ ...base, supportedPlatforms: [...base.supportedPlatforms], enabledPlatforms: [...base.enabledPlatforms] });
    const ig = m.entries.filter((e) => e.platform === "instagram");
    expect(ig).toHaveLength(5);
    expect(ig.map((e) => `${e.localDate} ${e.localTime}`)).toEqual(["2026-10-19 08:00", "2026-10-20 08:00", "2026-10-21 08:00", "2026-10-22 08:00", "2026-10-23 08:00"]);
    expect(ig.every((e) => e.mode === "assist")).toBe(true);
    expect(ig[0]).toMatchObject({ contentId: "c1", scheduledAt: "2026-10-19T12:00:00.000Z", idempotencyKey: "post:c1:instagram:2", accountId: "acct-ig" });
    const tt = m.entries.filter((e) => e.platform === "tiktok");
    expect(tt).toHaveLength(7);
    expect(new Set(tt.map((e) => e.localDate)).size).toBe(7);
    expect(tt.every((e) => e.mode === "auto")).toBe(true);
    expect(m.unplaced.filter((u) => u.platform === "instagram").map((u) => u.contentId)).toEqual(["c6", "c7", "c8"]);
    expect(m.skippedPlatforms).toEqual(expect.arrayContaining([
      { platform: "youtube", reason: "no connected account" },
      { platform: "linkedin", reason: "your publisher can't post there" },
      { platform: "facebook", reason: "not turned on in your workspace config" },
    ]));
  });

  it("counts already-taken slots against the week and never double-books a minute", () => {
    const taken = [{ platform: "instagram" as const, scheduledAt: "2026-10-19T12:00:00.000Z" }, { platform: "instagram" as const, scheduledAt: "2026-10-20T12:00:00.000Z" }];
    const slots = planSlots("instagram", settings.cadence.instagram!, { weekStart: "2026-10-19", timezone: TZ, taken, now: NOW, leadMinutes: 15 });
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.localDate)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
  });

  it("skips slots in the past or inside the lead time, and uses second slots when a day allows two", () => {
    const cadence = { perWeek: 6, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[], slots: ["08:00", "19:00"], maxPerDay: 2 };
    // This week, now = Wed 08:00 local: Mon–Wed 08:00 are gone (Wed 08:00 is inside the lead time).
    const slots = planSlots("tiktok", cadence, { weekStart: "2026-10-12", timezone: TZ, taken: [], now: NOW, leadMinutes: 15 });
    expect(slots.map((s) => `${s.localDate} ${s.localTime}`)).toEqual(["2026-10-14 19:00", "2026-10-15 08:00", "2026-10-15 19:00", "2026-10-16 08:00", "2026-10-17 08:00", "2026-10-18 08:00"]);
  });

  it("autopost puts Instagram on auto; keys are stable", () => {
    const m = buildWeekManifest({ ...base, supportedPlatforms: [...base.supportedPlatforms], enabledPlatforms: [...base.enabledPlatforms], instagramAutopost: true });
    expect(m.entries.find((e) => e.platform === "instagram")!.mode).toBe("auto");
    expect(postIdempotencyKey("c1", "tiktok", 3, "trial-2026-10-19-0")).toBe("post:c1:tiktok:3:trial-2026-10-19-0");
  });
});

describe("cross-post CTA swap", () => {
  const ig = "Three ways to make a hand-bound notebook last.\n\nComment STITCH and I'll send you the guide.\n\n#bookbinding #notebooks #handmade";
  const lines = { linkLine: "The comment keyword only works on Instagram. Get it here instead: {link}", linkInBioLine: "Get it from the link in bio." };

  it("detects keyword CTA lines", () => {
    expect(isKeywordCtaLine("Comment STITCH and I'll send it", "stitch")).toBe(true);
    expect(isKeywordCtaLine("Stitching tips below", "stitch")).toBe(false);
    expect(isKeywordCtaLine("DM me STITCH", "stitch")).toBe(true);
  });

  it("uses the link line where links work and link-in-bio on TikTok, keeping hashtags last", () => {
    const yt = swapKeywordCta({ caption: ig, keyword: "stitch", platform: "youtube", link: "https://examplebrand.example/l/st12", ...lines });
    expect(yt.swapped).toBe(true);
    expect(yt.caption).toBe("Three ways to make a hand-bound notebook last.\n\nThe comment keyword only works on Instagram. Get it here instead: https://examplebrand.example/l/st12\n\n#bookbinding #notebooks #handmade");
    const tt = swapKeywordCta({ caption: ig, keyword: "stitch", platform: "tiktok", link: "https://examplebrand.example/l/st12", ...lines });
    expect(tt.caption).toContain("Get it from the link in bio.");
    expect(tt.caption).not.toContain("STITCH");
  });

  it("trims the body (never the link line) to fit X", () => {
    const long = `${"Binding notes ".repeat(30).trim()}\nComment STITCH for the guide.`;
    const x = swapKeywordCta({ caption: long, keyword: "stitch", platform: "x", link: "https://examplebrand.example/l/st12", ...lines });
    expect(x.caption.endsWith("Get it here instead: https://examplebrand.example/l/st12")).toBe(true);
    expect(x.caption.length).toBeLessThanOrEqual(280 + 60);
  });

  it("leaves captions without a keyword CTA alone", () => {
    expect(swapKeywordCta({ caption: "Just a tip. #bookbinding", keyword: "stitch", platform: "youtube", link: "https://x.example", ...lines })).toEqual({ caption: "Just a tip. #bookbinding", swapped: false });
  });
});

describe("payload checks", () => {
  const caps: PublisherCapabilities = { platforms: ["instagram", "tiktok"], scheduling: true, instagramTrialReels: false, instagramCollaborators: true, firstComment: true };
  const accounts: SocialAccount[] = [{ providerAccountId: "acct-ig", platform: "instagram", handle: "examplebrand.studio", status: "connected" }, { providerAccountId: "acct-tt", platform: "tiktok", handle: "examplebrand.studio", status: "connected" }];
  const req: PublishRequest = {
    idempotencyKey: "post:c1:instagram:1", accountId: "acct-ig", platform: "instagram", caption: "Comment STITCH for the guide.",
    media: [{ kind: "video", localPath: "/tmp/examplebrand/a.mp4", mimeType: "video/mp4", durationS: 30 }], scheduledAt: "2026-10-19T12:00:00Z",
  };
  const run = (r: PublishRequest, extra: Partial<Parameters<typeof checkPayload>[0]> = {}) =>
    checkPayload({ request: r, accounts, capabilities: caps, now: NOW, leadMinutes: 15, cta: { type: "comment_keyword", keyword: "stitch" }, ...extra });

  it("passes a good payload and fails before any API call on CTA rules", () => {
    expect(run(req).ok).toBe(true);
    const missing = run({ ...req, caption: "No call to action here." });
    expect(missing.errors.map((e) => e.code)).toContain("publishing.keyword_missing");
    const tt = run({ ...req, platform: "tiktok", accountId: "acct-tt", caption: "Comment STITCH", options: { tiktok: { privacy: "public", aiGenerated: false } } });
    expect(tt.errors.map((e) => e.code)).toContain("publishing.tiktok_cta");
    expect(run({ ...req, platform: "tiktok", accountId: "acct-tt", caption: "DM me STITCH", options: { tiktok: { privacy: "public", aiGenerated: false } } }).ok).toBe(true);
  });

  it("delegates account, schedule and trial-reel rules to guardrails", () => {
    expect(run({ ...req, accountId: "nope" }).errors.map((e) => e.code)).toContain("payload.account_missing");
    expect(run({ ...req, scheduledAt: "2026-10-14T12:05:00Z" }).errors.map((e) => e.code)).toContain("payload.schedule_past");
    const trial = run({ ...req, options: { instagram: { trialReel: true } } }, { acknowledgements: { trialReelsRisk: false } });
    expect(trial.errors.map((e) => e.code)).toEqual(expect.arrayContaining(["payload.trial_reel_unsupported", "payload.trial_reel_not_acknowledged"]));
  });
});

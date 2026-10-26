import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProviderError, parseConfig, silentLogger } from "@attentionos/core";
import {
  create, parseDuration, parseInstagramItem, parseInstagramProfile, parseTiktokItem, parseTiktokProfile, parseYoutubeItem, parseYoutubeProfile,
} from "../src/index.ts";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

type Call = { url: string; method: string; body?: string; auth?: string | null };

function fakeFetch(routes: [RegExp, number, unknown][]) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined, auth: new Headers(init?.headers).get("authorization") });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route[2]), { status: route[1], headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

const config = parseConfig({});
const secrets = (s: Record<string, string>) => (k: string) => s[k];

describe("parsers", () => {
  it("parses Instagram reel items and drops unusable ones", () => {
    const items = fx("instagram-reels.json") as unknown[];
    const posts = items.map((i) => parseInstagramItem(i, "demo_creator_a"));
    expect(posts[0]).toMatchObject({
      platform: "instagram", platformPostId: "QfDemoReel01", authorHandle: "demo_creator_a", views: 48210, likes: 2210, comments: 412,
      durationS: 41.2, isPinned: false, publishedAt: "2026-10-08T14:00:00.000Z",
    });
    expect(posts[0]!.topComments![0]).toEqual({ text: "The second one got me last year", likes: 41 });
    // hidden likes (-1) become unknown; string counts are coerced; URL is derived from the short code
    expect(posts[1]!.likes).toBeUndefined();
    expect(posts[1]).toMatchObject({ comments: 35, isPinned: true, views: 9000, url: "https://www.instagram.com/reel/QfDemoReel02/" });
    expect(posts[2]).toBeNull();
  });
  it("parses TikTok items", () => {
    const [a, b] = (fx("tiktok-videos.json") as unknown[]).map((i) => parseTiktokItem(i, "demo_creator_b"));
    expect(a).toMatchObject({ platform: "tiktok", views: 125000, likes: 9100, comments: 220, shares: 310, durationS: 34 });
    expect(b!.publishedAt).toBe(new Date(1791000000 * 1000).toISOString());
    expect(b!.url).toBe("https://www.tiktok.com/@demo_creator_b/video/7420000000000000002");
  });
  it("parses YouTube items and durations", () => {
    const [y] = (fx("youtube-shorts.json") as unknown[]).map((i) => parseYoutubeItem(i, "demo_creator_c"));
    expect(y).toMatchObject({ platform: "youtube", durationS: 48, views: 18200, comments: 51 });
    expect(y!.caption).toContain("Why your remodel quote doubled");
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("x")).toBeUndefined();
  });
});

describe("Apify scraper contract", () => {
  it("runs the actor, polls, reads the dataset and records the real run cost", async () => {
    const { impl, calls } = fakeFetch([
      [/\/acts\/apify~instagram-reel-scraper\/runs/, 201, fx("run-started.json")],
      [/\/actor-runs\/RunDemo0001\?/, 200, fx("run-succeeded.json")],
      [/\/datasets\/DsDemo0001\/items/, 200, fx("instagram-reels.json")],
    ]);
    const scraper = create({ secret: secrets({ APIFY_TOKEN: "demo-token" }), config, log: silentLogger, fetch: impl });
    const posts = await scraper.listCreatorPosts("@demo_creator_a", "instagram", { limit: 12 });
    expect(posts.map((p) => p.platformPostId)).toEqual(["QfDemoReel01", "QfDemoReel02"]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ username: ["demo_creator_a"], resultsLimit: 12 });
    expect(calls[0]!.auth).toBe("Bearer demo-token");
    expect(calls.every((c) => !c.url.includes("token="))).toBe(true);
    const spend = scraper.drainSpend();
    expect(spend).toEqual([{ usd: 0.0412, estimated: false, actorId: "apify~instagram-reel-scraper", runId: "RunDemo0001", handle: "@demo_creator_a", platform: "instagram", items: 3 }]);
    expect(scraper.drainSpend()).toEqual([]);
  });

  it("filters by since", async () => {
    const { impl } = fakeFetch([
      [/\/runs\?/, 201, { data: { id: "R", status: "SUCCEEDED", defaultDatasetId: "D" } }],
      [/\/datasets\/D\/items/, 200, fx("instagram-reels.json")],
    ]);
    const scraper = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: impl });
    const posts = await scraper.listCreatorPosts("demo_creator_a", "instagram", { since: "2026-10-01T00:00:00Z" });
    expect(posts).toHaveLength(1);
    // no usageTotalUsd → estimated from item count
    expect(scraper.drainSpend()[0]).toMatchObject({ estimated: true, items: 3 });
  });

  it("estimates cost from actor pricing", async () => {
    const scraper = create({ secret: secrets({}), config, log: silentLogger, fetch: fakeFetch([]).impl });
    const usd = await scraper.estimateCostUsd([{ handle: "a", platform: "instagram" }, { handle: "b", platform: "tiktok" }, { handle: "c", platform: "linkedin" }], { limit: 100 });
    expect(usd).toBeCloseTo(0.005 + 0.27 + 0.005 + 0.4, 6);
  });

  it("reads actor overrides from module settings", async () => {
    const cfg = parseConfig({ modules: { research: { settings: { apify: { actors: { instagram: { actorId: "demo~ig-actor", usdPer1000Results: 1 } } } } } } });
    const { impl, calls } = fakeFetch([[/\/acts\/demo~ig-actor\/runs/, 201, { data: { id: "R", status: "SUCCEEDED", defaultDatasetId: "D" } }], [/\/datasets\/D/, 200, []]]);
    const scraper = create({ secret: secrets({ APIFY_TOKEN: "t" }), config: cfg, log: silentLogger, fetch: impl });
    await scraper.listCreatorPosts("x", "instagram");
    expect(calls[0]!.url).toContain("demo~ig-actor");
    expect(await scraper.estimateCostUsd([{ handle: "x", platform: "instagram" }], { limit: 1000 })).toBe(1);
  });

  it("maps failures to ProviderError codes", async () => {
    const noToken = create({ secret: secrets({}), config, log: silentLogger, fetch: fakeFetch([]).impl });
    await expect(noToken.listCreatorPosts("a", "instagram")).rejects.toMatchObject({ code: "auth" });
    await expect(noToken.listCreatorPosts("a", "linkedin")).rejects.toMatchObject({ code: "unsupported" });

    const failed = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: fakeFetch([[/\/runs\?/, 201, { data: { id: "R", status: "FAILED", defaultDatasetId: "D", statusMessage: "Profile is private" } }]]).impl });
    const err = await failed.listCreatorPosts("a", "tiktok").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain("Profile is private");

    const limited = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: fakeFetch([[/\/runs\?/, 402, { error: { type: "not-enough-usage-to-run-paid-actor" } }]]).impl });
    await expect(limited.listCreatorPosts("a", "instagram")).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  it("reports account usage and health without spending", async () => {
    const { impl } = fakeFetch([[/\/users\/me\/limits/, 200, fx("user-limits.json")], [/\/users\/me$/, 200, { data: { username: "demo" } }]]);
    const scraper = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: impl });
    expect(await scraper.accountUsageUsd()).toEqual({ usedUsd: 7.31, limitUsd: 29 });
    expect(await scraper.health()).toEqual({ ok: true, detail: "Connected to Apify as demo" });
    const bad = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: fakeFetch([[/users/, 401, { error: { type: "token-not-valid" } }]]).impl });
    const h = await bad.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toBe("Apify rejected the token");
    expect(h.fix).toContain("APIFY_TOKEN");
    // No token at all: say so without calling the API.
    const calls: string[] = [];
    const none = create({ secret: secrets({}), config, log: silentLogger, fetch: (async (u: string) => (calls.push(String(u)), new Response("{}"))) as unknown as typeof fetch });
    expect(await none.health()).toMatchObject({ ok: false, detail: "No Apify token" });
    expect(calls).toEqual([]);
  });
});

describe("account numbers", () => {
  const AT = "2026-10-12T09:00:00.000Z";
  it("parses follower counts from profile and post items", () => {
    expect(parseInstagramProfile((fx("instagram-profile.json") as unknown[])[0], "x", AT)).toEqual({
      platform: "instagram", handle: "demo_creator_a", followers: 23140, following: 402, posts: 318, capturedAt: AT,
    });
    const [withMeta, withoutCounts] = fx("tiktok-videos.json") as unknown[];
    expect(parseTiktokProfile(withMeta, "x", AT)).toEqual({ platform: "tiktok", handle: "demo_creator_b", followers: 48200, following: 310, posts: 212, capturedAt: AT });
    expect(parseTiktokProfile(withoutCounts, "x", AT)).toBeNull();
    expect(parseYoutubeProfile((fx("youtube-shorts.json") as unknown[])[0], "x", AT)).toEqual({ platform: "youtube", handle: "demo_creator_c", followers: 12900, posts: 164, capturedAt: AT });
    // Reel items carry no follower count.
    expect(parseInstagramProfile((fx("instagram-reels.json") as unknown[])[0], "x", AT)).toBeNull();
  });

  it("reuses the counts a TikTok post run already returned, without another run", async () => {
    const { impl, calls } = fakeFetch([
      [/\/acts\/clockworks~tiktok-scraper\/runs/, 201, { data: { id: "R", status: "SUCCEEDED", defaultDatasetId: "D", usageTotalUsd: 0.02 } }],
      [/\/datasets\/D\/items/, 200, fx("tiktok-videos.json")],
    ]);
    const scraper = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: impl, now: () => new Date(AT) });
    await scraper.listCreatorPosts("@demo_creator_b", "tiktok");
    scraper.drainSpend();
    const runsBefore = calls.length;
    expect(await scraper.fetchProfile("demo_creator_b", "tiktok", { maxUsd: 0 })).toMatchObject({ followers: 48200, following: 310, posts: 212 });
    expect(calls.length).toBe(runsBefore);
    expect(scraper.drainSpend()).toEqual([]);
  });

  it("runs the Instagram profile actor once and records its cost as a profile run", async () => {
    const { impl, calls } = fakeFetch([
      [/\/acts\/apify~instagram-profile-scraper\/runs/, 201, { data: { id: "RunP", status: "SUCCEEDED", defaultDatasetId: "DsP", usageTotalUsd: 0.0031 } }],
      [/\/datasets\/DsP\/items/, 200, fx("instagram-profile.json")],
    ]);
    const scraper = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: impl, now: () => new Date(AT) });
    const p = await scraper.fetchProfile("@demo_creator_a", "instagram", { maxUsd: 1 });
    expect(p).toEqual({ platform: "instagram", handle: "demo_creator_a", followers: 23140, following: 402, posts: 318, capturedAt: AT });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ usernames: ["demo_creator_a"] });
    expect(scraper.drainSpend()).toEqual([
      { usd: 0.0031, estimated: false, actorId: "apify~instagram-profile-scraper", runId: "RunP", handle: "@demo_creator_a", platform: "instagram", items: 1, kind: "profile" },
    ]);
    // A second read within the hour is served from the first.
    await scraper.fetchProfile("demo_creator_a", "instagram");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses a paid profile run above the budget left, and reads YouTube counts from a one-item post run", async () => {
    const { impl, calls } = fakeFetch([
      [/\/acts\/streamers~youtube-scraper\/runs/, 201, { data: { id: "Y", status: "SUCCEEDED", defaultDatasetId: "DY" } }],
      [/\/datasets\/DY\/items/, 200, fx("youtube-shorts.json")],
    ]);
    const scraper = create({ secret: secrets({ APIFY_TOKEN: "t" }), config, log: silentLogger, fetch: impl, now: () => new Date(AT) });
    await expect(scraper.fetchProfile("demo_creator_a", "instagram", { maxUsd: 0.001 })).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(calls).toHaveLength(0);
    expect(await scraper.fetchProfile("demo_creator_c", "youtube")).toMatchObject({ followers: 12900 });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ maxResultsShorts: 1 });
    expect(scraper.drainSpend()[0]).toMatchObject({ kind: "profile", estimated: true, actorId: "streamers~youtube-scraper", items: 1 });
  });
});

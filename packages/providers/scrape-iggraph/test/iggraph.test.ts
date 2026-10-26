import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig, silentLogger } from "@attentionos/core";
import { create, createOwnAnalytics, parseInsights } from "../src/index.ts";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

type Route = [(url: URL) => boolean, number, unknown];
function fakeFetch(routes: Route[]) {
  const calls: URL[] = [];
  const impl = async (url: string) => {
    const u = new URL(url);
    calls.push(u);
    const r = routes.find(([m]) => m(u));
    if (!r) return new Response(JSON.stringify({ error: { message: "no route", code: 1 } }), { status: 404 });
    return new Response(JSON.stringify(r[2]), { status: r[1] });
  };
  return { impl, calls };
}

const secrets = { IG_ACCESS_TOKEN: "demo-token", IG_USER_ID: "17841400000000000" };
const base = { secret: (k: string) => (secrets as Record<string, string>)[k], config: parseConfig({}), log: silentLogger };
const fields = (u: URL) => u.searchParams.get("fields") ?? "";

describe("business_discovery scraper", () => {
  it("reads public professional accounts", async () => {
    const { impl, calls } = fakeFetch([[(u) => fields(u).startsWith("business_discovery"), 200, fx("business-discovery.json")]]);
    const s = create({ ...base, fetch: impl });
    const posts = await s.listCreatorPosts("@demo_creator_a", "instagram", { limit: 10 });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      platform: "instagram", platformPostId: "17900000000000001", authorHandle: "demo_creator_a", views: 61000, likes: 1830, comments: 214,
      url: "https://www.instagram.com/reel/DemoGraph01/", videoUrl: "https://cdn.example.invalid/g1.mp4", publishedAt: "2026-10-06T16:00:00.000Z",
    });
    expect(posts[1]!.videoUrl).toBeUndefined();
    expect(fields(calls[0]!)).toContain("business_discovery.username(demo_creator_a)");
    expect(fields(calls[0]!)).toContain("media.limit(10)");
    expect(calls[0]!.pathname).toBe("/v23.0/17841400000000000");
    expect(await s.estimateCostUsd([{ handle: "a", platform: "instagram" }])).toBe(0);
  });

  it("retries without view_count when the API tier rejects it", async () => {
    const { impl, calls } = fakeFetch([
      [(u) => fields(u).includes("view_count"), 400, fx("error-view-count.json")],
      [(u) => fields(u).startsWith("business_discovery"), 200, fx("business-discovery.json")],
    ]);
    const posts = await create({ ...base, fetch: impl }).listCreatorPosts("demo_creator_a", "instagram", { since: "2026-10-01T00:00:00Z" });
    expect(calls).toHaveLength(2);
    expect(posts).toHaveLength(1);
  });

  it("maps Graph errors and rejects other platforms", async () => {
    const { impl } = fakeFetch([[() => true, 400, fx("error-not-business.json")]]);
    const s = create({ ...base, fetch: impl });
    await expect(s.listCreatorPosts("someone", "instagram")).rejects.toMatchObject({ code: "not_found" });
    await expect(s.listCreatorPosts("someone", "tiktok")).rejects.toMatchObject({ code: "unsupported" });
    const expired = create({ ...base, fetch: fakeFetch([[() => true, 400, { error: { message: "Session has expired", code: 190 } }]]).impl });
    await expect(expired.listCreatorPosts("x", "instagram")).rejects.toMatchObject({ code: "auth" });
    const noCreds = create({ ...base, secret: () => undefined, fetch: impl });
    await expect(noCreds.listCreatorPosts("x", "instagram")).rejects.toMatchObject({ code: "auth" });
    expect((await noCreds.health()).ok).toBe(false);
  });
});

describe("own analytics", () => {
  it("pages through media, fetches insights per type and stops at since", async () => {
    const { impl, calls } = fakeFetch([
      [(u) => u.pathname.endsWith("/media") && u.searchParams.get("after") === "PAGE2", 200, fx("own-media-page2.json")],
      [(u) => u.pathname.endsWith("/media"), 200, fx("own-media-page1.json")],
      [(u) => u.pathname.includes("18000000000000011/insights"), 200, fx("insights-reel.json")],
      [(u) => u.pathname.includes("/insights") && (u.searchParams.get("metric") ?? "").includes("follows"), 400, fx("error-unsupported-metric.json")],
      [(u) => u.pathname.includes("/insights"), 200, fx("insights-fallback.json")],
    ]);
    const a = createOwnAnalytics({ ...base, fetch: impl, now: () => new Date("2026-10-11T00:00:00Z") });
    const rows = await a.listPostMetrics("17841400000000000", { since: "2026-09-01T00:00:00Z" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      platformPostId: "18000000000000011", platform: "instagram", views: 15400, reach: 11020, saves: 212, shares: 97, likes: 310, comments: 64,
      avgWatchTimeS: 9.12, capturedAt: "2026-10-11T00:00:00.000Z",
    });
    // the image post rejected the feed metrics, fell back to reach + saved
    expect(rows[1]).toMatchObject({ platformPostId: "18000000000000012", reach: 900, saves: 7 });
    expect(calls.some((c) => c.searchParams.get("after") === "PAGE2")).toBe(true);
  });

  it("honours the limit", async () => {
    const { impl } = fakeFetch([
      [(u) => u.pathname.endsWith("/media"), 200, fx("own-media-page1.json")],
      [(u) => u.pathname.includes("/insights"), 200, fx("insights-reel.json")],
    ]);
    expect(await createOwnAnalytics({ ...base, fetch: impl }).listPostMetrics("me", { limit: 1 })).toHaveLength(1);
  });

  it("parses both insight value shapes", () => {
    expect(parseInsights(fx("insights-fallback.json"))).toEqual({ reach: 900, saved: 7 });
    expect(parseInsights({ nope: 1 })).toEqual({});
  });
});

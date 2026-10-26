import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestWorkspace, DEMO_BRAND_DIR } from "@attentionos/module-research/testing";
import { isPlaceholderRemixTitle, remixTitle } from "@attentionos/core";
import { nicheRelevance, provenScore, rankRemixSources, remixSlots, sameVideoKeys, type RemixPoolItem, type RemixRankOptions } from "../src/remix.ts";
import { remixPool } from "../src/repo.ts";
import { runBrief } from "../src/jobs/brief.ts";

const NOW = new Date("2026-10-12T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function item(id: string, over: Partial<RemixPoolItem> = {}): RemixPoolItem {
  return {
    id, url: `https://www.instagram.com/reel/${id}/`, creator: "@demo_creator_a", platform: "instagram", x: 4, views: 50_000, publishedAt: daysAgo(3),
    own: false, tier: "core", hasBlueprint: false, hasTranscript: true, topic: null, hookPattern: null, format: null,
    matchText: "kitchen remodel quote cabinets budget", used: false, ...over,
  };
}

const OPTS: RemixRankOptions = { now: NOW, nicheWords: ["kitchen", "remodel", "budget", "cabinet", "quote"], maxAgeDays: 30, ownMaxAgeDays: 365, minX: 2, ownMinX: 2, halfLifeDays: 14 };

describe("remix source ranking", () => {
  it("keeps proven posts (pinned or past bigViews) whatever their age or their normal", () => {
    const ranked = rankRemixSources([
      item("pinned-3m", { views: 3_382_520, x: 1.2, publishedAt: daysAgo(95), proven: true }),
      item("old-unproven", { views: 40_000, x: 5, publishedAt: daysAgo(95) }),
      item("low-x-unproven", { views: 40_000, x: 1.2 }),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["pinned-3m"]);
    // Past the proven age limit it drops out too.
    expect(rankRemixSources([item("ancient", { views: 2_000_000, x: 1, publishedAt: daysAgo(400), proven: true })], OPTS)).toEqual([]);
  });

  it("ranks by absolute views and times-normal together", () => {
    const ranked = rankRemixSources([
      item("small-big-x", { views: 8_000, x: 9 }),
      item("viral", { views: 1_200_000, x: 14 }),
      item("big-views-low-x", { views: 900_000, x: 2.1 }),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["viral", "big-views-low-x", "small-big-x"]);
    expect(ranked[0]!.reasons).toEqual(expect.arrayContaining(["14x their normal", "1,200,000 views", "in your niche"]));
    expect(provenScore(1_000_000, 16)).toBeCloseTo(1, 5);
    expect(provenScore(null, null)).toBe(0);
  });

  it("drops posts already remixed, too old, or not clearly above their normal", () => {
    const ranked = rankRemixSources([
      item("used", { used: true, x: 20 }),
      item("old", { publishedAt: daysAgo(45), x: 20 }),
      item("meh", { x: 1.5 }),
      item("ok"),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["ok"]);
  });

  it("prefers fresh posts, the owner's niche, closer tiers and posts with a ready blueprint", () => {
    expect(rankRemixSources([item("stale", { publishedAt: daysAgo(28) }), item("fresh")], OPTS)[0]!.id).toBe("fresh");
    expect(rankRemixSources([item("offtopic", { matchText: "sports cars and racing" }), item("niche")], OPTS)[0]!.id).toBe("niche");
    expect(rankRemixSources([item("adjacent", { tier: "adjacent" }), item("core")], OPTS)[0]!.id).toBe("core");
    expect(rankRemixSources([item("raw", { hasTranscript: false }), item("ready", { hasBlueprint: true })], OPTS)[0]!.id).toBe("ready");
    expect(nicheRelevance("nothing relevant", new Set(["kitchen"]))).toBe(0.6);
    // Calls to action and platform words aren't niche, even when a Brand Kit uses them.
    expect(nicheRelevance("Link in comments, follow for more", new Set(["link", "comment", "follow", "kitchen"]))).toBe(0.6);
    expect(nicheRelevance("anything", new Set())).toBe(1);
  });

  it("keeps the owner's own breakouts much longer (do that again, new angle)", () => {
    const ranked = rankRemixSources([
      item("own-old", { own: true, tier: "own", publishedAt: daysAgo(200), x: 3, creator: "@owner" }),
      item("own-flop", { own: true, tier: "own", x: 1.2 }),
      item("comp-old", { publishedAt: daysAgo(200), x: 3 }),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["own-old"]);
    expect(ranked[0]!.reasons[0]).toBe("3x your normal");
  });
});

describe("big proven reels first", () => {
  it("a competitor reel that pulled hundreds of thousands outranks the owner's small breakout", () => {
    const ranked = rankRemixSources([
      item("own-small", { own: true, tier: "own", creator: "@owner", views: 2_100, x: 5.7, hasBlueprint: true, publishedAt: daysAgo(10) }),
      item("comp-big", { views: 833_000, x: 135, publishedAt: daysAgo(4) }),
      item("comp-pinned", { views: 3_380_000, x: 1, publishedAt: daysAgo(4), proven: true }),
    ], { ...OPTS, ownMinViews: 0 });
    expect(ranked.map((r) => r.id)).toEqual(["comp-big", "comp-pinned", "own-small"]);
    // An older pinned reel in the owner's niche beats a fresh big reel off it.
    const niche = rankRemixSources([
      item("fresh-offtopic", { views: 630_000, x: 59, publishedAt: daysAgo(2), matchText: "browser games link in comments" }),
      item("pinned-in-niche", { views: 860_000, x: 239, publishedAt: daysAgo(95), proven: true }),
    ], OPTS);
    expect(niche.map((r) => r.id)).toEqual(["pinned-in-niche", "fresh-offtopic"]);
    // Under the absolute bar the owner's own post doesn't qualify at all.
    expect(rankRemixSources([item("own-small", { own: true, tier: "own", views: 2_100, x: 5.7 })], { ...OPTS, ownMinViews: 10_000 })).toEqual([]);
    expect(rankRemixSources([item("own-big", { own: true, tier: "own", views: 40_000, x: 5.7 })], { ...OPTS, ownMinViews: 10_000 }).map((r) => r.id)).toEqual(["own-big"]);
    // Views from 1K (nothing) to 1M (full marks).
    expect(provenScore(900, null)).toBe(0);
    expect(provenScore(1_000_000, null)).toBeCloseTo(0.65, 5);
  });

  it("keeps only the best-ranked copy of a video the creator posted more than once", () => {
    const hook = "If we did this back in school I would never have finished a single class";
    const ranked = rankRemixSources([
      item("repost-a", { views: 830_000, x: 130, sameVideo: sameVideoKeys("@demo_creator_a", hook, 24.82) }),
      item("repost-b", { views: 630_000, x: 60, sameVideo: sameVideoKeys("@demo_creator_a", hook, 24.82) }),
      item("pinned-copy", { views: 3_300_000, x: 1, proven: true, matchText: "crazy world", sameVideo: sameVideoKeys("@demo_creator_a", null, 24.82) }),
      item("other", { views: 500_000, x: 40, sameVideo: sameVideoKeys("@demo_creator_a", "A different hook about kitchen quotes entirely", 31) }),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["repost-a", "other"]);
  });

  it("titles a remix by its blueprint topic, and knows a placeholder when it sees one", () => {
    const base = { own: false, handle: "demo_creator_a", platform: "instagram", views: 833_000 };
    expect(remixTitle(base)).toBe("Remix: @demo_creator_a's 833K-view instagram post");
    expect(remixTitle({ ...base, own: true, views: 2_100 })).toBe("Remix: your 2.1K-view instagram post");
    expect(remixTitle({ ...base, topic: "what a cheap quote leaves out." })).toBe("Remix: What a cheap quote leaves out");
    const long = "A free surprising discovery that lets people do something they normally pay for or download, demoed live on screen";
    expect(remixTitle({ ...base, topic: long })).toBe("Remix: A free surprising discovery that lets people do something they normally pay for");
    expect(isPlaceholderRemixTitle(remixTitle(base))).toBe(true);
    expect(isPlaceholderRemixTitle(remixTitle({ ...base, views: null }))).toBe(true);
    expect(isPlaceholderRemixTitle("Remix: What a cheap quote leaves out")).toBe(false);
  });
});

describe("remix share of the slate", () => {
  it("turns most of the slate into remixes, keeping the offer and one news slot", () => {
    expect(remixSlots({ news: 2, remix: 2, talking_head: 2, offer: 1 }, 0.7)).toEqual({ news: 1, remix: 5, talking_head: 0, offer: 1 });
    expect(remixSlots({ news: 0, remix: 1, talking_head: 6, offer: 1 }, 0.7)).toEqual({ news: 0, remix: 6, talking_head: 1, offer: 1 });
  });

  it("never shrinks the offer, and 0 leaves the configured slots alone", () => {
    expect(remixSlots({ news: 0, remix: 0, talking_head: 0, offer: 2 }, 1)).toEqual({ news: 0, remix: 0, talking_head: 0, offer: 2 });
    expect(remixSlots({ news: 2, remix: 2, talking_head: 2, offer: 1 }, 0)).toEqual({ news: 2, remix: 2, talking_head: 2, offer: 1 });
    expect(remixSlots({ news: 1, remix: 0, talking_head: 1, offer: 1 }, 1)).toEqual({ news: 0, remix: 2, talking_head: 0, offer: 1 });
  });
});

function brandCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "aos-strategy-remix-")), "brand");
  cpSync(DEMO_BRAND_DIR, dir, { recursive: true });
  return dir;
}

describe("remix-first brief (database)", () => {
  it("plans the owner's breakouts and competitor outliers, and waits for a teardown when the blueprint is missing", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000301", brandDir: brandCopy(), now: () => NOW });
    const [own] = await ws.sql`insert into tracked_creators (workspace_id, platform, handle, tier, active) values (${ws.id}, 'instagram', 'examplebrand', 'own', true) returning id`;
    // Own posts: median 10,000 views; one breakout at 6x (past the 10K-view bar for the owner's own posts).
    for (const [i, views] of [10_000, 9000, 11_000, 60_000].entries()) {
      await ws.sql`insert into external_posts (workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, views)
        values (${ws.id}, ${own!.id}, 'instagram', ${`own${i}`}, 'examplebrand', ${`https://www.instagram.com/reel/own${i}/`}, ${daysAgo(60)}, ${views})`;
    }
    const [comp] = await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, views, x_score, is_outlier, transcript)
      values (${ws.id}, 'instagram', 'c1', 'demo_creator_a', 'https://www.instagram.com/reel/c1/', ${daysAgo(2)}, 61200, 4.2, true, 'A transcript') returning id`;
    // The competitor post already has a checked blueprint.
    await ws.sql`insert into teardowns (workspace_id, external_post_id, platform, author_handle, url, analysis_md, fingerprint)
      values (${ws.id}, ${comp!.id}, 'instagram', 'demo_creator_a', 'https://www.instagram.com/reel/c1/', 'x',
              ${ws.sql.json({ facets: { blueprint: { topic: "What a cheap quote leaves out", hookLine: "x", beats: [] } } })})`;

    const pool = await remixPool(ws, { maxAgeDays: 30, ownMaxAgeDays: 365 });
    expect(pool.find((p) => p.own && p.x > 5)).toMatchObject({ creator: "@examplebrand", x: 5.71, hasBlueprint: false });
    expect(pool.find((p) => p.id === comp!.id)).toMatchObject({ x: 4.2, views: 61200, hasBlueprint: true, topic: "What a cheap quote leaves out" });

    const r = await runBrief(ws, { mode: "daily" });
    const remixes = r.items.filter((i) => i.brief.kind === "remix");
    expect(remixes).toHaveLength(2);
    const fromComp = remixes.find((i) => (i.brief.remixOf as { externalPostId: string }).externalPostId === comp!.id)!;
    expect(fromComp.title).toBe("Remix: What a cheap quote leaves out");
    expect(fromComp.brief.remixOf).toMatchObject({ own: false, line: "Based on @demo_creator_a's reel, 61.2K views, 4.2x their normal" });
    const fromOwn = remixes.find((i) => (i.brief.remixOf as { own: boolean }).own)!;
    expect(fromOwn.brief.remixOf).toMatchObject({ line: "Based on your own reel, 60K views, 5.7x your normal" });

    // The own breakout has no blueprint yet: its script waits while research tears it down, then starts early.
    const runs = await ws.sql<{ job_id: string; input: Record<string, unknown>; run_after: Date }[]>`
      select job_id, input, run_after from agent_runs where workspace_id = ${ws.id} and job_id in ('scripting.write-script', 'research.teardown-prep')`;
    const script = (id: string) => runs.find((x) => x.job_id === "scripting.write-script" && x.input.contentId === id);
    expect(script(fromOwn.id)!.run_after.getTime() - NOW.getTime()).toBe(30 * 60_000);
    expect(script(fromComp.id)!.run_after.getTime() - NOW.getTime()).toBe(10 * 60_000);
    expect(runs.filter((x) => x.job_id === "research.teardown-prep").map((x) => x.input)).toEqual([
      { externalPostId: (fromOwn.brief.remixOf as { externalPostId: string }).externalPostId, reuseBlueprint: true, then: { jobId: "scripting.remix-ready", agent: "copywriter", input: { contentId: fromOwn.id } } },
    ]);
  });
  it("an older idea that only cited a proven reel doesn't block a proper remix of it; a filmed or remixed one does", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000302", brandDir: brandCopy(), now: () => NOW });
    const [big] = await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, views, is_pinned, transcript)
      values (${ws.id}, 'instagram', 'c-big', 'demo_creator_b', 'https://www.instagram.com/reel/c-big/', ${daysAgo(80)}, 900000, true, 'A transcript') returning id`;
    const [filmed] = await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, views, is_pinned, transcript)
      values (${ws.id}, 'instagram', 'c-filmed', 'demo_creator_b', 'https://www.instagram.com/reel/c-filmed/', ${daysAgo(80)}, 700000, true, 'A transcript') returning id`;
    for (const [post, status] of [[big!.id, "scripted"], [filmed!.id, "filming"]] as const) {
      await ws.sql`insert into content (workspace_id, title, status, brief, source_refs)
        values (${ws.id}, 'Old structure idea', ${status}, ${ws.sql.json({ kind: "remix" })}, ${ws.sql.json([{ type: "external_post", id: post }])})`;
    }

    const [remixed] = await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, views, is_pinned)
      values (${ws.id}, 'instagram', 'c-remixed', 'demo_creator_b', 'https://www.instagram.com/reel/c-remixed/', ${daysAgo(10)}, 600000, true) returning id`;
    await ws.sql`insert into content (workspace_id, title, status, brief, source_refs)
      values (${ws.id}, 'A proper remix', 'idea', ${ws.sql.json({ kind: "remix", remixOf: { externalPostId: remixed!.id } })}, ${ws.sql.json([{ type: "external_post", id: remixed!.id }])})`;
    const pool = await remixPool(ws, { maxAgeDays: 30, ownMaxAgeDays: 365 });
    expect(pool.find((p) => p.id === big!.id)).toMatchObject({ used: false, proven: true });
    expect(pool.find((p) => p.id === filmed!.id)).toMatchObject({ used: true });
    expect(pool.find((p) => p.id === remixed!.id)).toMatchObject({ used: true });

    // ...and the brief plans a proper remix of the reel the old draft only cited.
    const r = await runBrief(ws, { mode: "batch", date: "2026-10-13" });
    const sources = r.items.filter((i) => i.brief.kind === "remix").map((i) => (i.brief.remixOf as { externalPostId: string }).externalPostId);
    expect(sources).toContain(big!.id);
    expect(sources).not.toContain(filmed!.id);
    expect(sources).not.toContain(remixed!.id);
  });
});

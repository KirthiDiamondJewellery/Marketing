import { describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@attentionos/core";
import { createTestWorkspace } from "@attentionos/module-research/testing";
import { bestSlots, competitorBenchmarks, overview, postDetail, postFacts, postUrlKey } from "../src/analytics/index.ts";

/**
 * Setup reads the owner's public account into `external_posts` under an `own` tracked creator (onboarding's
 * import-own-posts). Analytics opts in to those rows so the numbers show from day one.
 */

const NOW = new Date("2026-10-15T17:00:00Z");
const D = 86_400_000;

type Scan = { code: string; daysAgo: number; views: number | null; likes?: number; comments?: number; shares?: number; caption?: string; durationS?: number; url?: string };

/** The rows onboarding writes: one `own` tracked creator and its posts (same shape as upsertOwnPosts). */
async function seedScan(ws: WorkspaceContext, posts: Scan[], handle = "my.account"): Promise<Record<string, string>> {
  const [c] = await ws.sql`
    insert into tracked_creators (workspace_id, platform, handle, tier, active, notes)
    values (${ws.id}, 'instagram', ${handle}, 'own', true, 'Your own account (added by setup)') returning id`;
  const ids: Record<string, string> = {};
  for (const p of posts) {
    const [row] = await ws.sql`
      insert into external_posts (workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, caption, duration_s,
                                  views, likes, comments, shares, thumbnail_url, first_seen_at, last_updated_at)
      values (${ws.id}, ${c!.id}, 'instagram', ${p.code}, ${handle}, ${p.url ?? `https://www.instagram.com/p/${p.code}/`}, ${new Date(NOW.getTime() - p.daysAgo * D)},
              ${p.caption ?? `Caption for ${p.code}\nsecond line`}, ${p.durationS ?? 28}, ${p.views}, ${p.likes ?? null}, ${p.comments ?? null}, ${p.shares ?? null},
              ${`https://cdn.example.test/${p.code}.jpg`}, ${new Date(NOW.getTime() - D)}, ${new Date(NOW.getTime() - D)})
      returning id`;
    ids[p.code] = row!.id as string;
  }
  return ids;
}

const tenPosts = (): Scan[] =>
  Array.from({ length: 10 }, (_, i) => ({ code: `SC${i}`, daysAgo: 4 + i * 3, views: i === 0 ? 90_000 : 10_000 + i * 500, likes: 400 + i * 10, comments: 30 + i, shares: 12 }));

describe("scanned own posts", () => {
  it("stay out of the default facts and join in when asked, scored against the account's normal", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    const ids = await seedScan(ws, tenPosts());
    expect((await postFacts(ws)).posts).toHaveLength(0);

    const { posts, norms } = await postFacts(ws, { includeScanned: true });
    expect(posts).toHaveLength(10);
    const top = posts.find((p) => p.postId === ids.SC0)!;
    expect(top).toMatchObject({ source: "scan", snapshot: "scan", views: 90_000, likes: 400, comments: 30, saves: null, settled: true, data: "full", title: "Caption for SC0" });
    expect(top.scan).toMatchObject({ handle: "my.account", thumbnailUrl: "https://cdn.example.test/SC0.jpg", transcribed: false });
    expect(top.features.length_bucket).toBe("15-30s");
    expect(top.rates.sendRate).toBeNull(); // a scan never sees saves, so no half-measured send rate
    expect(top.rates.engagementPerView).toBeCloseTo((400 + 30 + 12) / 90_000, 6);
    expect(top.x).not.toBeNull();
    expect(top.x!).toBeGreaterThan(2);
    expect(norms.instagram!.medianViews).toBeGreaterThan(10_000);
  });

  it("drops a scanned post that is already a published post (matched by URL shortcode)", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    const ids = await seedScan(ws, tenPosts());
    // The publishing service names the post by its numeric media id and a /reel/ URL; the scan used the shortcode.
    const [pub] = await ws.sql`
      insert into posts (workspace_id, platform, provider, status, platform_post_id, published_at, idempotency_key, url)
      values (${ws.id}, 'instagram', 'zernio', 'published', '17999000111', ${new Date(NOW.getTime() - 4 * D)}, 'k:pub', 'https://www.instagram.com/reel/SC0/?igsh=abc')
      returning id`;
    await ws.sql`insert into post_metrics (workspace_id, post_id, captured_at, snapshot, views, likes, comments) values (${ws.id}, ${pub!.id}, ${NOW}, 'latest', 91000, 410, 31)`;
    const { posts } = await postFacts(ws, { includeScanned: true });
    expect(posts).toHaveLength(10);
    expect(posts.some((p) => p.postId === ids.SC0)).toBe(false);
    expect(posts.find((p) => p.postId === pub!.id)).toMatchObject({ source: "published", views: 91_000 });
  });

  it("feeds the overview, best slots and post detail", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    const ids = await seedScan(ws, tenPosts());
    const ov = await overview(ws, { days: 30, includeScanned: true });
    expect(ov.kpis.find((k) => k.key === "posts")!.value).toBe(9); // SC9 is 31 days old
    expect(ov.kpis.find((k) => k.key === "views")!.value).toBeGreaterThan(90_000);
    expect(ov.kpis.find((k) => k.key === "engagement")!.value).toBeGreaterThan(0);
    expect(ov.best?.post.postId).toBe(ids.SC0);
    expect((await overview(ws, { days: 30 })).best).toBeNull();

    const slots = await bestSlots(ws, { includeScanned: true });
    expect(slots.n).toBe(10);

    const d = await postDetail(ws, ids.SC0!, { includeScanned: true });
    expect(d).not.toBeNull();
    expect(d!.caption).toContain("Caption for SC0");
    expect(d!.series).toEqual([]);
    expect(await postDetail(ws, ids.SC0!)).toBeNull();
  });

  it("never counts your own account as a competitor", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    await seedScan(ws, tenPosts());
    const [peer] = await ws.sql`insert into tracked_creators (workspace_id, platform, handle, tier) values (${ws.id}, 'instagram', 'peer.one', 'core') returning id`;
    for (let i = 0; i < 6; i++) {
      await ws.sql`
        insert into external_posts (workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, views, likes, comments, x_score, is_outlier)
        values (${ws.id}, ${peer!.id}, 'instagram', ${`P${i}`}, 'peer.one', ${`https://www.instagram.com/p/P${i}/`}, ${new Date(NOW.getTime() - (5 + i) * D)}, ${20_000 + i * 1000}, 800, 60, ${i === 0 ? 4 : 1}, ${i === 0})`;
    }
    const { posts } = await postFacts(ws, { includeScanned: true });
    const [ig] = await competitorBenchmarks(ws, posts, { days: 90, outlierDays: 90 });
    expect(ig!.peers.map((p) => p.key)).toEqual(["peer.one"]);
    expect(ig!.own.n).toBe(10);
    expect(ig!.outliers.map((o) => o.handle)).toEqual(["@peer.one"]);
  });
});

describe("postUrlKey", () => {
  it("reads the platform's post id from common URL shapes", () => {
    expect(postUrlKey("https://www.instagram.com/p/AbC_12-x/")).toBe("AbC_12-x");
    expect(postUrlKey("https://instagram.com/reel/AbC_12-x/?igsh=1")).toBe("AbC_12-x");
    expect(postUrlKey("https://www.instagram.com/some.user/reel/AbC_12-x/")).toBe("AbC_12-x");
    expect(postUrlKey("https://www.tiktok.com/@some.user/video/7301234567890")).toBe("7301234567890");
    expect(postUrlKey("https://youtube.com/shorts/dEmOvIdEo01?feature=share")).toBe("dEmOvIdEo01");
    expect(postUrlKey("https://www.youtube.com/watch?v=dEmOvIdEo01&t=3")).toBe("dEmOvIdEo01");
    expect(postUrlKey("https://youtu.be/dEmOvIdEo01")).toBe("dEmOvIdEo01");
    expect(postUrlKey("https://Example.test/Post/1/?a=b")).toBe("example.test/post/1");
    expect(postUrlKey(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { PostMetricsSnapshot, ToolDefinition, WorkspaceContext } from "@attentionos/core";
import { createTestWorkspace } from "@attentionos/module-research/testing";
import { recordCost } from "@attentionos/module-research";
import learnModule, {
  buildWeeklyBriefing, captureDueSnapshots, computeOwnScores, costWatch, findPostMortemCandidates, getWeights, northStar, runAttribution, scanPostMortems,
} from "../src/index.ts";

const NOW = new Date("2026-10-11T12:00:00Z");
const H = 3_600_000;
const tool = (name: string) => learnModule.tools.find((t) => t.name === name) as ToolDefinition;
const call = (ws: WorkspaceContext, name: string, input: Record<string, unknown>) => tool(name).handler({ ws, actor: "agent:analyst" }, tool(name).input.parse(input));

type Seed = { key: string; hoursAgo: number; views: number; comments: number; lane?: string; hook?: string; label?: string; durationS?: number };

async function seed(ws: WorkspaceContext, posts: Seed[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const p of posts) {
    const published = new Date(ws.now().getTime() - p.hoursAgo * H);
    const [c] = await ws.sql`insert into content (workspace_id, title, status, lane, hook_pattern, template, funnel_stage, cta_type)
      values (${ws.id}, ${`Post ${p.key}`}, 'published', ${p.lane ?? null}, ${p.hook ?? null}, 'raw-talking-head', 'tofu', 'follow') returning id`;
    const [row] = await ws.sql`insert into posts (workspace_id, content_id, platform, provider, status, platform_post_id, published_at, idempotency_key, url)
      values (${ws.id}, ${c!.id}, 'instagram', 'fake', 'published', ${p.key}, ${published}, ${`k:${p.key}`}, ${`https://www.instagram.com/reel/${p.key}/`}) returning id`;
    ids[p.key] = row!.id as string;
    if (p.views >= 0) {
      await ws.sql`insert into post_metrics (workspace_id, post_id, captured_at, snapshot, views, comments, raw)
        values (${ws.id}, ${row!.id}, ${ws.now()}, ${p.label ?? "7d"}, ${p.views}, ${p.comments}, ${ws.sql.json({ durationS: p.durationS ?? 30 })})`;
    }
  }
  return ids;
}

/** 12 mature posts: "proof" lane does ~3x, "myth" lane ~1x. */
const history = (): Seed[] => [
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ key: `proof${i}`, hoursAgo: 24 * (10 + i), views: 30_000 + i * 100, comments: 120, lane: "proof", hook: "question" })),
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ key: `myth${i}`, hoursAgo: 24 * (10 + i) + 1, views: 10_000 + i * 100, comments: 40, lane: "myth", hook: "list" })),
];

describe("module definition", () => {
  it("is a valid module with prefixed tools", () => {
    expect(learnModule.manifest.dependsOn).toEqual(["research"]);
    for (const t of learnModule.tools) expect(t.name).toMatch(/^learn_/);
    for (const j of learnModule.jobs) expect(j.id).toMatch(/^learn\./);
  });
});

describe("snapshot capture", () => {
  it("captures due labels from one provider pull and skips posts not in the data", async () => {
    const snaps: PostMetricsSnapshot[] = [];
    const analytics = { id: "fake", health: async () => ({ ok: true, detail: "" }), listPostMetrics: async () => snaps };
    const ws = await createTestWorkspace({ providers: { ownAnalytics: analytics }, now: () => NOW });
    const ids = await seed(ws, [
      { key: "fresh", hoursAgo: 1.5, views: -1, comments: 0 },
      { key: "day", hoursAgo: 25, views: -1, comments: 0 },
      { key: "missing", hoursAgo: 2, views: -1, comments: 0 },
      { key: "old", hoursAgo: 24 * 40, views: -1, comments: 0 },
    ]);
    snaps.push(
      { platformPostId: "fresh", platform: "instagram", capturedAt: NOW.toISOString(), views: 900, comments: 12 },
      { platformPostId: "day", platform: "instagram", capturedAt: NOW.toISOString(), views: 5000, comments: 40 },
    );
    const r = await captureDueSnapshots(ws);
    expect(r).toEqual({ due: 3, captured: 2, missing: 1 });
    const rows = await ws.sql`select post_id, snapshot, views::int from post_metrics where workspace_id = ${ws.id} and snapshot <> 'latest' order by views`;
    expect(rows).toEqual([{ post_id: ids.fresh, snapshot: "1h", views: 900 }, { post_id: ids.day, snapshot: "24h", views: 5000 }]);
    expect((await captureDueSnapshots(ws)).due).toBe(1); // only "missing" is still due
  });

  it("reports when a snapshot is due but nothing can read metrics", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    await seed(ws, [{ key: "a", hoursAgo: 1.2, views: -1, comments: 0 }]);
    expect(await captureDueSnapshots(ws)).toMatchObject({ skipped: "no_provider", due: 1 });
  });
});

describe("own baseline, attribution and weights", () => {
  it("scores posts against the account's own normal and writes feature stats with GAP lines", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    await seed(ws, [...history(), { key: "offer0", hoursAgo: 24 * 12 + 2, views: 20_000, comments: 80, lane: "offer", hook: "question" }]);
    const { posts, baselines } = await computeOwnScores(ws);
    expect(baselines.instagram).toMatchObject({ n: 13, sufficient: true, comments: 80 });
    const proof = posts.find((p) => p.features.lane === "proof")!;
    expect(proof.x).toBeGreaterThan(1.3);
    expect(proof.features).toMatchObject({ format: "raw-talking-head", funnel_stage: "tofu", length_bucket: "30-45s" });

    const run = await runAttribution(ws);
    expect(run.windows["90d"]!.n).toBe(13);
    expect(run.windows["90d"]!.gaps).toContain('GAP: lane "offer" has 1 post (need 5). Not enough data to judge yet.');
    const stats = await ws.sql`select dimension, value, n, lift::float8 from feature_stats where workspace_id = ${ws.id} and time_window = '90d' and dimension = 'lane' order by value`;
    expect(stats.map((s) => [s.value, s.n])).toEqual([["myth", 6], ["offer", 1], ["proof", 6]]);
    expect(stats.find((s) => s.value === "proof")!.lift).toBeGreaterThan(1);

    const w = await getWeights(ws);
    expect(w.ownPosts).toBe(13);
    expect(w.ownShare).toBe(0.65);
    expect(w.source).toBe("blend");
    expect(w.explore).toBe(0.2);
    expect(w.weights.lane!.proof).toBeGreaterThan(1);
    expect(w.weights.lane!.myth).toBeLessThan(1);
    expect(w.weights.lane!.offer).toBeUndefined();

    const fs = (await call(ws, "learn_get_feature_stats", { dimension: "lane" })) as { lines: string[]; weightSource: string };
    expect(fs.lines.some((l) => l.startsWith("GAP:"))).toBe(true);
    expect(fs.weightSource).toBe("blend");
    const summary = (await call(ws, "learn_get_performance_summary", { days: 30 })) as { posts: number; top: { title: string }[]; best: { title: string; why: string[] } };
    expect(summary.posts).toBe(13);
    expect(summary.top[0]!.title).toMatch(/^Post proof/);
    expect(summary.best.title).toMatch(/^Post proof/);
  });

  it("falls back to competitor signals with no own data", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    for (let i = 0; i < 6; i++) {
      await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, x_score, tags)
        values (${ws.id}, 'instagram', ${`c${i}`}, 'demo_creator_a', ${`https://e.example/${i}`}, ${new Date(NOW.getTime() - (i + 1) * 86_400_000)}, ${i < 3 ? 4 : 1}, ${ws.sql.json({ format: i < 3 ? "green-screen" : "talking-head" })})`;
    }
    await runAttribution(ws);
    const w = await getWeights(ws);
    expect(w.source).toBe("none"); // 3 per format is under min n
    await ws.sql`update feature_stats set n = 6 where workspace_id = ${ws.id}`;
    const w2 = await getWeights(ws);
    expect(w2.source).toBe("competitor");
    expect(w2.weights.format!["green-screen"]).toBeGreaterThan(1);
  });
});

describe("post-mortems", () => {
  it("finds breakouts, flops and new bests once settled, and saves validated drafts", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    const ids = await seed(ws, [
      ...history(),
      { key: "rocket", hoursAgo: 80, views: 90_000, comments: 400, lane: "proof", label: "72h" },
      { key: "dud", hoursAgo: 100, views: 3_000, comments: 10, lane: "myth", label: "72h" },
      { key: "young", hoursAgo: 10, views: 90_000, comments: 400, label: "latest" },
    ]);
    const cands = await findPostMortemCandidates(ws);
    const byPost = Object.fromEntries(cands.map((c) => [c.postId, c.kind]));
    expect(byPost[ids.rocket!]).toBe("new_best");
    expect(byPost[ids.dud!]).toBe("flop");
    expect(byPost[ids.young!]).toBeUndefined();
    const scan = await scanPostMortems(ws);
    expect(scan.queued).toBe(cands.length);
    expect((await scanPostMortems(ws)).queued).toBe(0); // deduped while queued

    const ctx = (await call(ws, "learn_get_post_context", { postId: ids.rocket })) as { post: { x: number }; plan: { lane: string } };
    expect(ctx.plan.lane).toBe("proof");
    expect(ctx.post.x).toBeGreaterThan(2);
    const body = "## What happened\nIt beat the normal by a wide margin across views and comments.\n\n## Why we think it happened\nThe hook named a specific number in the first second and the lane is our strongest.\n\n## What to repeat\nNumber-first hooks in the proof lane.\n\n## What to change\nNothing structural; test a stronger keyword CTA.\n";
    await expect(call(ws, "learn_save_post_mortem", { postId: ids.rocket, kind: "new_best", bodyMd: body.replace("## What to change", "## Next"), lessons: ["Lead with the number"] })).rejects.toThrow(/What to change/);
    const saved = (await call(ws, "learn_save_post_mortem", { postId: ids.rocket, kind: "new_best", bodyMd: body, lessons: ["Lead with the number in proof posts"] })) as { saved: boolean; x: number };
    expect(saved.saved).toBe(true);
    expect(saved.x).toBeGreaterThan(2);
    const listed = (await call(ws, "learn_list_post_mortems", {})) as { kind: string; lessons: { text: string }[] }[];
    expect(listed[0]).toMatchObject({ kind: "new_best", lessons: [{ text: "Lead with the number in proof posts" }] });
    expect((await findPostMortemCandidates(ws)).some((c) => c.postId === ids.rocket)).toBe(false);
  });
});

describe("north star, weekly briefing and cost watch", () => {
  it("measures leads, reports gaps honestly and builds the weekly numbers", async () => {
    const ws = await createTestWorkspace({ now: () => NOW, config: { northStar: { metric: "leads_per_week", target: 5 } } });
    await ws.sql`insert into contacts (workspace_id, email, created_at) values (${ws.id}, 'lead1@example.com', ${new Date(NOW.getTime() - 2 * 86_400_000)}), (${ws.id}, 'lead2@example.com', ${new Date(NOW.getTime() - 9 * 86_400_000)})`;
    expect(await northStar(ws)).toMatchObject({ metric: "leads_per_week", value: 1, previous: 1, target: 5 });
    const calls = await createTestWorkspace({ now: () => NOW, config: { northStar: { metric: "booked_calls_per_week" } } });
    expect((await northStar(calls)).gap).toMatch(/^GAP: no booking data/);

    await seed(ws, [...history(), { key: "thisweek", hoursAgo: 80, views: 30_000, comments: 150, lane: "proof", label: "72h" }]);
    await runAttribution(ws);
    const b = await buildWeeklyBriefing(ws);
    expect(b.posts).toBe(1);
    expect(b.markdown).toContain("Leads per week: 1 (last week 1), target 5");
    expect(b.markdown).toContain("Posts published: 1");
    expect(b.best!.title).toBe("Post thisweek");
    const tool = (await call(ws, "learn_get_weekly_briefing", {})) as { weekEnding: string };
    expect(tool.weekEnding).toBe("2026-10-11");
  });

  it("warns at 80% and alerts when over, once per period", async () => {
    const ws = await createTestWorkspace({ now: () => NOW, config: { budgets: { dailyUsd: 5, scrapingMonthlyUsd: 10, imagesDailyUsd: 2 } } });
    await recordCost(ws, { category: "llm", provider: "anthropic", usd: 4.2 });
    await recordCost(ws, { category: "scraping", provider: "apify", usd: 11 });
    const lines = await costWatch(ws);
    expect(lines.map((l) => [l.category, l.level])).toEqual([["llm", "warn"], ["scraping", "over"], ["images", "ok"]]);
    await costWatch(ws);
    const msgs = await ws.sql`select body from messages where workspace_id = ${ws.id} order by id`;
    expect(msgs.map((m) => (m.body as { text: string }).text)).toEqual([
      "AI spend today is $4.20, 84% of your $5.00 budget.",
      "Scraping spend this month is $11, over your $10 budget. Jobs that spend on this will pause until the budget resets or you raise it.",
    ]);
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger, type Scraper, type ToolDefinition, type WorkspaceContext } from "@attentionos/core";
import { createTestWorkspace } from "@attentionos/module-research/testing";
import learnModule, {
  buildWeeklyBriefing, captureFollowers, followerGrowth, funnelReport, goalPacingReport, importFunnelCsvs, loadFeatureStats, normalizeSiteEvent,
  northStar, overview, postDetail, postFacts, readCsv, recordFunnelEvents, refreshScanFollowers, runAttribution, siteEvents, weeklyReport,
} from "../src/index.ts";

const NOW = new Date("2026-10-15T17:00:00Z"); // a Thursday
const H = 3_600_000;
const D = 24 * H;
const tool = (name: string) => learnModule.tools.find((t) => t.name === name) as ToolDefinition;
const call = (ws: WorkspaceContext, name: string, input: Record<string, unknown>) => tool(name).handler({ ws, actor: "agent:analyst" }, tool(name).input.parse(input));

type P = {
  key: string; hoursAgo: number; views: number; comments?: number; likes?: number; shares?: number; saves?: number; follows?: number;
  lane?: string; hook?: string; label?: string; early?: number; utm?: string; platform?: string; variantOf?: string; skip?: number; raw?: Record<string, unknown>;
};

async function seed(ws: WorkspaceContext, posts: P[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const p of posts) {
    const published = new Date(ws.now().getTime() - p.hoursAgo * H);
    const [c] = await ws.sql`insert into content (workspace_id, title, status, lane, hook_pattern, template, funnel_stage, cta_type)
      values (${ws.id}, ${`Post ${p.key}`}, 'published', ${p.lane ?? "proof"}, ${p.hook ?? "question"}, 'talking-head', 'tofu', 'comment') returning id`;
    const [row] = await ws.sql`insert into posts (workspace_id, content_id, platform, provider, status, platform_post_id, published_at, idempotency_key, url, utm_content, variant_of)
      values (${ws.id}, ${c!.id}, ${p.platform ?? "instagram"}, 'fake', 'published', ${p.key}, ${published}, ${`k:${p.key}`}, ${`https://example.test/${p.key}`}, ${p.utm ?? null}, ${p.variantOf ? ids[p.variantOf]! : null}) returning id`;
    ids[p.key] = row!.id as string;
    if (p.early !== undefined) {
      await ws.sql`insert into post_metrics (workspace_id, post_id, captured_at, snapshot, views) values (${ws.id}, ${row!.id}, ${new Date(published.getTime() + 24 * H)}, '24h', ${p.early})`;
    }
    await ws.sql`insert into post_metrics (workspace_id, post_id, captured_at, snapshot, views, likes, comments, shares, saves, follows, raw)
      values (${ws.id}, ${row!.id}, ${new Date(published.getTime() + Math.min(p.hoursAgo, 168) * H)}, ${p.label ?? "7d"}, ${p.views}, ${p.likes ?? Math.round(p.views * 0.04)},
              ${p.comments ?? Math.round(p.views * 0.004)}, ${p.shares ?? Math.round(p.views * 0.003)}, ${p.saves ?? Math.round(p.views * 0.006)}, ${p.follows ?? Math.round(p.views * 0.002)},
              ${ws.sql.json({ durationS: 30, ...(p.raw ?? {}) })})`;
    if (p.skip !== undefined) {
      await ws.sql`insert into post_metrics (workspace_id, post_id, captured_at, snapshot, skip_rate, raw)
        values (${ws.id}, ${row!.id}, ${ws.now()}, 'import', ${p.skip}, ${ws.sql.json({ source: "csv" })})`;
    }
  }
  return ids;
}

/** 12 settled posts: "proof" ~3x the "myth" lane. */
const history = (): P[] => [
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ key: `proof${i}`, hoursAgo: 24 * (10 + i * 3), views: 30_000 + i * 100, comments: 120, lane: "proof", early: 9_000 + i * 100, saves: 600, shares: 300 })),
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ key: `myth${i}`, hoursAgo: 24 * (11 + i * 3), views: 10_000 + i * 100, comments: 40, lane: "myth", early: 3_000 + i * 100, saves: 30, shares: 10 })),
];

describe("post facts", () => {
  it("collapses trial variants into the best variant's numbers", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    const ids = await seed(ws, [...history(), { key: "main", hoursAgo: 100, views: 8_000 }, { key: "trial", hoursAgo: 99, views: 40_000, variantOf: "main" }]);
    const { posts } = await postFacts(ws);
    expect(posts).toHaveLength(13);
    const main = posts.find((p) => p.postId === ids.main)!;
    expect(main).toMatchObject({ variants: 2, numbersFrom: ids.trial, views: 40_000 });
    expect(posts.some((p) => p.postId === ids.trial)).toBe(false);
  });

  it("computes rates, velocity and hold, filling skip rate and retention from other captures", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    const ids = await seed(ws, [
      ...history(),
      { key: "fast", hoursAgo: 80, views: 50_000, early: 30_000, label: "72h", skip: 0.35, saves: 900, shares: 600, follows: 250 },
      { key: "curve", hoursAgo: 90, views: 12_000, label: "72h", raw: { aos: { clicks: 40, retention: [{ t: 0, pct: 100 }, { t: 2, pct: 70 }, { t: 4, pct: 50 }] } } },
    ]);
    const { posts, norms } = await postFacts(ws);
    const fast = posts.find((p) => p.postId === ids.fast)!;
    expect(fast.skipRate).toBe(0.35);
    expect(fast.hold3s).toBe(0.65);
    expect(fast.rates.sendRate).toBeCloseTo(1500 / 50_000, 6);
    expect(fast.rates.followsPer1k).toBe(5);
    expect(fast.velocity).toBeGreaterThan(4);
    const curve = posts.find((p) => p.postId === ids.curve)!;
    expect(curve.hold3s).toBe(0.6); // interpolated between 70% at 2s and 50% at 4s
    expect(curve.clicks).toBe(40);
    expect(curve.rates.clickRate).toBeCloseTo(40 / 12_000, 6);
    expect(norms.instagram!.medianViews).toBeGreaterThan(10_000);
  });
});

describe("funnel", () => {
  it("normalizes loose website events and rejects what it can't read", () => {
    expect(normalizeSiteEvent({ type: "booking_created", utm: { content: "wallcheck_38", source: "Instagram" }, email: "A@example.com", timestamp: 1_760_000_000 })).toMatchObject({
      kind: "booking", utmContent: "wallcheck_38", utmSource: "instagram", email: "a@example.com", at: new Date(1_760_000_000_000).toISOString(),
    });
    expect(normalizeSiteEvent({ event: "purchase", amount_cents: 129900, email: "not-an-email" })).toEqual({ kind: "sale", valueUsd: 1299 });
    expect(normalizeSiteEvent({ event: "something_else" })).toBeNull();
    expect(normalizeSiteEvent("nope")).toBeNull();
    expect(siteEvents({ events: [{ kind: "lead" }, { kind: "?" }] })).toMatchObject({ skipped: 1, events: [{ kind: "lead" }] });
    expect(readCsv('Event,UTM Content,Value\nsale,"a_1","1,200"\n')).toEqual([{ event: "sale", utm_content: "a_1", value: "1,200" }]);
  });

  it("credits contacts and website events to posts, dedupes, and measures bookings and revenue", async () => {
    const ws = await createTestWorkspace({ now: () => NOW, config: { northStar: { metric: "booked_calls_per_week", target: 3 } } });
    const ids = await seed(ws, [...history(), { key: "offer", hoursAgo: 72, views: 20_000, utm: "audit_51", label: "72h" }, { key: "offer-tt", hoursAgo: 72, views: 9_000, utm: "audit_51", platform: "tiktok", label: "72h" }]);
    expect((await northStar(ws)).gap).toMatch(/^GAP: no booking data/);
    await ws.sql`insert into contacts (workspace_id, email, utm_content, platform, created_at) values (${ws.id}, 'lead@example.com', 'audit_51', 'instagram', ${new Date(NOW.getTime() - D)})`;
    const r = await recordFunnelEvents(ws, [
      { kind: "click", utmContent: "audit_51", utmSource: "tiktok", visitorId: "v1", at: new Date(NOW.getTime() - 2 * D).toISOString(), id: "e1" },
      { kind: "lead", visitorId: "v1", email: "lead@example.com", at: new Date(NOW.getTime() - 2 * D + H).toISOString(), id: "e2" },
      { kind: "booking", visitorId: "v1", at: new Date(NOW.getTime() - D).toISOString(), id: "e3" },
      { kind: "sale", utmContent: "audit_51", valueUsd: 1500, at: new Date(NOW.getTime() - 2 * H).toISOString(), id: "e4" },
    ], "webhook");
    expect(r).toEqual({ stored: 4, duplicates: 0, matched: 2 });
    expect((await recordFunnelEvents(ws, [{ kind: "click", id: "e1" }], "webhook")).duplicates).toBe(1);

    const { posts } = await postFacts(ws);
    const tt = posts.find((p) => p.postId === ids["offer-tt"])!;
    expect(tt.funnel).toMatchObject({ clicks: 1, leads: 1, bookings: 1 }); // first touch on TikTok; lead deduped by email
    const ig = posts.find((p) => p.postId === ids.offer)!;
    expect(ig.funnel).toMatchObject({ leads: 0, sales: 1, revenue: 1500 });

    const f = await funnelReport(ws, posts, 5);
    expect(f.steps.map((s) => [s.key, s.value])).toEqual([["views", 29_000], ["clicks", 1], ["leads", 1], ["bookings", 1], ["sales", 1]]);
    expect(f.clicksSource).toBe("website");
    expect(f.totals.revenue).toBe(1500);
    expect(await northStar(ws)).toMatchObject({ value: 1, target: 3 });
    const pacing = await goalPacingReport(ws, { history: 2 });
    expect(pacing[0]).toMatchObject({ metric: "booked_calls_per_week", isNorthStar: true });
    expect(pacing[0]!.pace.actual).toBe(1);
    expect(pacing[0]!.daily).toHaveLength(7);
    expect(pacing[0]!.history).toHaveLength(2);
    const ft = (await call(ws, "learn_get_funnel", { days: 5 })) as { topPosts: { postId: string }[] };
    expect(ft.topPosts[0]!.postId).toBe(ids.offer);
  });

  it("runs the website webhook job and imports CSVs idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "aos-learn-"));
    mkdirSync(join(root, "imports/funnel"), { recursive: true });
    writeFileSync(join(root, "imports/funnel/oct.csv"), "type,utm_content,email,date\nlead,audit_51,a@example.com,2026-10-14\nlead,audit_51,b@example.com,2026-10-14\nwhatever,,,\n");
    const ws = await createTestWorkspace({ now: () => NOW, root });
    const job = learnModule.jobs.find((j) => j.id === "learn.webhook-site")!;
    const progress: string[] = [];
    const ctx = { ws, input: job.input.parse({ provider: "site", payload: { events: [{ type: "lead", utm_content: "x_1" }] } }), actor: "system", runId: "r", log: silentLogger, signal: new AbortController().signal, progress: async (m: string) => void progress.push(m) };
    expect(await (job as { run(c: unknown): Promise<unknown> }).run(ctx)).toMatchObject({ stored: 1, skipped: 0 });
    expect(progress[0]).toBe("Recorded 1 website event");
    expect(await importFunnelCsvs(ws)).toEqual({ files: 1, stored: 2, duplicates: 0, skipped: 1 });
    expect(await importFunnelCsvs(ws)).toEqual({ files: 1, stored: 0, duplicates: 2, skipped: 1 });
  });
});

describe("followers, overview and reports", () => {
  it("captures follower history from a provider that can read it and charts growth", async () => {
    const stats = [
      { day: "2026-09-10", followers: 1000 }, { day: "2026-10-01", followers: 1100 }, { day: "2026-10-08", followers: 1150 }, { day: "2026-10-15", followers: 1210 },
    ];
    const analytics = { id: "fake", health: async () => ({ ok: true, detail: "" }), listPostMetrics: async () => [], listAccountStats: async () => stats };
    const ws = await createTestWorkspace({ now: () => NOW, providers: { ownAnalytics: analytics } });
    await ws.sql`insert into social_accounts (workspace_id, provider, provider_account_id, platform, handle) values (${ws.id}, 'fake', 'acct1', 'instagram', 'demo')`;
    expect(await captureFollowers(ws, { backfillDays: 60 })).toEqual({ accounts: 1, days: 4 });
    expect((await captureFollowers(ws)).days).toBe(4); // upserts, no duplicates
    const g = await followerGrowth(ws, 90);
    expect(g).toMatchObject({ current: 1210, delta7: 60, previous7: 50, delta30: 210, growthChange: 0.2 });
    expect(g.series).toHaveLength(4);
    const none = await createTestWorkspace({ now: () => NOW });
    expect((await followerGrowth(none)).gap).toMatch(/^GAP: no follower history/);
    expect(await captureFollowers(none)).toMatchObject({ skipped: "no_provider" });
  });

  it("re-reads follower counts off the owner's public accounts weekly and folds them into a connected account later", async () => {
    const reads: string[] = [];
    const spend: { usd: number }[] = [];
    const scraper: Scraper = {
      id: "apify",
      health: async () => ({ ok: true, detail: "" }),
      listCreatorPosts: async () => [],
      estimateCostUsd: async () => 0,
      async fetchProfile(handle, platform) {
        reads.push(`${platform}:${handle}`);
        spend.push({ usd: 0.004 });
        return { platform, handle, followers: 5_000 + reads.length, capturedAt: ws.now().toISOString() };
      },
      drainSpend: () => spend.splice(0, spend.length),
    };
    let now = NOW;
    const ws = await createTestWorkspace({ now: () => now, providers: { scraper }, config: { acknowledgements: { scrapingTerms: true } } });
    await ws.sql`insert into tracked_creators (workspace_id, platform, handle, tier) values (${ws.id}, 'instagram', 'demo_owner', 'own'), (${ws.id}, 'instagram', 'peer_b', 'core')`;

    expect(await refreshScanFollowers(ws)).toMatchObject({ checked: 1, recorded: 1 });
    expect(reads).toEqual(["instagram:demo_owner"]); // competitors are never read here
    // Fresh within the week: nothing to do.
    now = new Date(NOW.getTime() + 3 * D);
    expect(await refreshScanFollowers(ws)).toMatchObject({ checked: 0, recorded: 0 });
    now = new Date(NOW.getTime() + 8 * D);
    expect(await refreshScanFollowers(ws)).toMatchObject({ checked: 1, recorded: 1 });
    expect(await followerGrowth(ws)).toMatchObject({ current: 5_002, lastDay: "2026-10-23", accounts: [{ handle: "demo_owner" }] });
    const [cost] = await ws.sql<{ n: number }[]>`select count(*)::int as n from cost_ledger where workspace_id = ${ws.id} and category = 'scraping'`;
    expect(cost?.n).toBe(2);

    // The owner connects the account through the publishing service: its provider history takes over, the scan's
    // earlier readings move onto it, and nothing is counted twice.
    await ws.sql`insert into social_accounts (workspace_id, provider, provider_account_id, platform, handle) values (${ws.id}, 'fake', 'acct-own', 'instagram', 'Demo_Owner')`;
    const analytics = { id: "fake", health: async () => ({ ok: true, detail: "" }), listPostMetrics: async () => [], listAccountStats: async () => [{ day: "2026-10-23", followers: 5_010 }] };
    const withProvider = Object.assign(Object.create(Object.getPrototypeOf(ws)), ws, { providers: { ...ws.providers, ownAnalytics: analytics } }) as WorkspaceContext;
    expect(await captureFollowers(withProvider)).toMatchObject({ days: 1 });
    const g = await followerGrowth(ws);
    expect(g.accounts).toHaveLength(1);
    expect(g.accounts[0]).toMatchObject({ handle: "Demo_Owner", followers: 5_010 });
    expect(g.series.map((p) => p.followers)).toEqual([5_001, 5_010]);
    const [left] = await ws.sql<{ n: number }[]>`select count(*)::int as n from social_accounts where workspace_id = ${ws.id} and provider = 'scan'`;
    expect(left?.n).toBe(0);

    const off = await createTestWorkspace({ now: () => NOW, providers: { scraper }, config: { acknowledgements: { scrapingTerms: false } } });
    expect(await refreshScanFollowers(off)).toMatchObject({ skipped: "terms" });
  });

  it("builds the overview, post detail, slots, benchmarks and the weekly report from one set of numbers", async () => {
    const ws = await createTestWorkspace({ now: () => NOW, config: { northStar: { metric: "leads_per_week", target: 4 } } });
    const ids = await seed(ws, [...history(), { key: "hit", hoursAgo: 80, views: 90_000, comments: 420, early: 40_000, label: "72h", saves: 2_000, shares: 1_500 }]);
    const [tc] = await ws.sql`insert into tracked_creators (workspace_id, platform, handle) values (${ws.id}, 'instagram', 'peer_a') returning id`;
    for (let i = 0; i < 6; i++) {
      await ws.sql`insert into external_posts (workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, views, likes, comments, x_score, is_outlier, spoken_hook)
        values (${ws.id}, ${tc!.id}, 'instagram', ${`ext${i}`}, 'peer_a', ${`https://example.test/ext${i}`}, ${new Date(NOW.getTime() - (i + 3) * D)}, ${40_000 + i * 1000}, 2000, 150, ${i === 0 ? 3.2 : 1}, ${i === 0}, ${i === 0 ? "Nobody tells you this about walls" : null})`;
    }
    await runAttribution(ws);
    const sendStats = await loadFeatureStats(ws, "90d", undefined, "send_rate");
    expect(sendStats.find((s) => s.dimension === "lane" && s.value === "proof")!.verdict).toBe("clear_win");

    const ov = await overview(ws, { days: 30 });
    expect(ov.best!.post.postId).toBe(ids.hit);
    expect(ov.best!.period).toBe("week");
    expect(ov.best!.why.length).toBeGreaterThan(0);
    expect(ov.trend).toHaveLength(12);
    expect(ov.kpis.find((k) => k.key === "send_rate")!.value).not.toBeNull();

    const d = await postDetail(ws, ids.hit!);
    expect(d!.series.map((s) => s.label)).toEqual(["24h", "72h"]);
    expect(d!.usualCurve.find((c) => c.label === "24h")!.n).toBe(12);
    expect(d!.rank).toEqual({ onPlatform: 1, of: 13 });

    const slots = (await call(ws, "learn_get_best_slots", {})) as { posts: number; byDay: unknown[] };
    expect(slots.posts).toBe(13);
    expect(slots.byDay).toHaveLength(7);
    const bench = (await call(ws, "learn_get_benchmarks", {})) as { platform: string; peerMedianViews: number; recentOutliers: { hook: string }[] }[];
    expect(bench[0]!.peerMedianViews).toBe(42_500);
    expect(bench[0]!.recentOutliers[0]!.hook).toMatch(/walls/);
    const detail = (await call(ws, "learn_get_post_detail", { postId: ids.hit })) as { velocity: number; retention: string };
    expect(detail.velocity).toBeGreaterThan(3);
    expect(detail.retention).toMatch(/^GAP/);
    const pacing = (await call(ws, "learn_get_goal_pacing", {})) as { goal: string; status: string }[];
    expect(pacing[0]!.goal).toBe("Leads per week");

    const r = await weeklyReport(ws);
    expect(r.best!.post.postId).toBe(ids.hit);
    expect(r.focus.some((f) => /^Rework or pause lane "myth": 0\.\d+× over 6 posts\.$/.test(f))).toBe(true);
    expect(r.losses[0]!.verdict).toBe("clear_loss");
    expect(r.markdown).toContain("Focus next week:");
    expect(r.markdown).toContain("Against tracked creators");
    const b = await buildWeeklyBriefing(ws);
    expect(b.headline).toBe(r.headline);
    expect(b.best!.why.length).toBeGreaterThan(0);
  });
});

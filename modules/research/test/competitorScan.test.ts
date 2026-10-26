import { describe, expect, it } from "vitest";
import { createTestWorkspace } from "../src/testing/db.ts";
import { runCompetitorScan } from "../src/jobs/competitorScan.ts";
import { listTrackedCreators } from "../src/repo/creators.ts";
import { listOutliers } from "../src/repo/externalPosts.ts";
import { recordCost } from "../src/lib/ops.ts";
import { daysAgo, fakeScraper, igPost, tempBrandDir } from "./helpers.ts";

const NOW = new Date("2026-10-11T12:00:00Z");

function library() {
  const history = (handle: string, n: number) =>
    Array.from({ length: n }, (_, i) => igPost(handle, `${handle}-h${i}`, daysAgo(NOW, 3 + i), { views: 10_000, comments: 40 }));
  return {
    demo_creator_a: [
      ...history("demo_creator_a", 8),
      igPost("demo_creator_a", "a-win", daysAgo(NOW, 1), { views: 30_000, comments: 200, caption: "Three kitchen permit mistakes that stall a remodel" }),
      igPost("demo_creator_a", "a-meme", daysAgo(NOW, 1), { views: 900_000, comments: 4_000, durationS: 8 }),
      igPost("demo_creator_a", "a-pinned", daysAgo(NOW, 30), { views: 900_000, comments: 4_000, pinned: true }),
    ],
    demo_creator_c: [
      ...history("demo_creator_c", 6),
      igPost("demo_creator_c", "c-win", daysAgo(NOW, 2), { views: 12_000, comments: 150, caption: "The kitchen permit question nobody asks" }),
    ],
  };
}

describe("competitor scan", () => {
  it("syncs creators, scores against each creator's baseline, finds cross-creator trends and queues transcription", async () => {
    const { scraper, calls } = fakeScraper(library());
    const ws = await createTestWorkspace({ brandDir: tempBrandDir(), providers: { scraper }, now: () => NOW });
    const res = await runCompetitorScan(ws, { runId: null });

    expect(res.skipped).toBeUndefined();
    expect(calls.sort()).toEqual(["instagram:demo_creator_a", "instagram:demo_creator_c", "tiktok:demo_creator_b"]);
    expect(res.scanned).toBe(3);
    expect(res.newOutliers).toBe(2);
    expect(res.spentUsd).toBeCloseTo(0.15, 6);

    const creators = await listTrackedCreators(ws);
    expect(creators.map((c) => c.handle).sort()).toEqual(["demo_creator_a", "demo_creator_b", "demo_creator_c"]);
    const a = creators.find((c) => c.handle === "demo_creator_a")!;
    expect(a.baseline).toMatchObject({ views: 10_000, comments: 40, n: 8, sufficient: true });

    const outliers = await listOutliers(ws, {});
    expect(outliers.map((o) => o.platformPostId)).toEqual(["a-win", "c-win"]);
    expect(outliers[0]!.xScore).toBe(4.4);
    expect(outliers[0]!.xDetail?.crossCreator).toEqual(expect.arrayContaining(["topic:kitchen", "topic:permit"]));
    const memes = await ws.sql`select is_meme, is_outlier from external_posts where workspace_id = ${ws.id} and platform_post_id = 'a-meme'`;
    expect(memes[0]).toEqual({ is_meme: true, is_outlier: false });
    const pinned = await ws.sql`select x_score from external_posts where workspace_id = ${ws.id} and platform_post_id = 'a-pinned'`;
    expect(pinned[0]!.x_score).toBeNull();

    expect(res.trends.map((t) => t.key)).toEqual(expect.arrayContaining(["topic:kitchen", "topic:permit"]));

    const runs = await ws.sql`select job_id, agent, input, dedupe_key from agent_runs where workspace_id = ${ws.id} order by dedupe_key`;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ job_id: "editing.transcribe", agent: "art_director" });
    expect(runs[0]!.input).toMatchObject({ kind: "external_post", replyTo: { jobId: "research.ingest-transcript", agent: "analyst" } });
    expect(res.transcriptionsQueued).toBe(2);

    const [ledger] = await ws.sql`select count(*)::int as n, sum(amount_micro)::int as micro from cost_ledger where workspace_id = ${ws.id} and category = 'scraping'`;
    expect(ledger).toEqual({ n: 3, micro: 150_000 });
    const snaps = await ws.sql`select count(*)::int as n from external_post_snapshots where workspace_id = ${ws.id}`;
    expect(snaps[0]!.n).toBe(18);

    // A second scan the same day re-snapshots but finds nothing new and queues nothing twice.
    const again = await runCompetitorScan(ws);
    expect(again.newOutliers).toBe(0);
    expect(again.transcriptionsQueued).toBe(0);
    const [count] = await ws.sql`select count(*)::int as n from external_posts where workspace_id = ${ws.id}`;
    expect(count!.n).toBe(18);
  });

  it("checks the budget BEFORE scraping and alerts instead of failing", async () => {
    const { scraper, calls } = fakeScraper(library());
    const ws = await createTestWorkspace({ brandDir: tempBrandDir(), providers: { scraper }, now: () => NOW, config: { budgets: { scrapingMonthlyUsd: 0.12 } } });
    await recordCost(ws, { category: "scraping", provider: "fake", usd: 0.1 });
    const res = await runCompetitorScan(ws);
    expect(res.skipped).toBe("budget");
    expect(calls).toEqual([]);
    const msgs = await ws.sql`select body from messages where workspace_id = ${ws.id}`;
    expect(msgs).toHaveLength(1);
    expect((msgs[0]!.body as { text: string }).text).toContain("Competitor scan skipped today");
    expect((msgs[0]!.body as { text: string }).text).toContain("$0.10 of your $0.12");
    // the same alert isn't repeated within a day
    await runCompetitorScan(ws);
    expect(await ws.sql`select id from messages where workspace_id = ${ws.id}`).toHaveLength(1);
  });

  it("shrinks the rotation to what the budget can afford", async () => {
    const { scraper, calls } = fakeScraper(library());
    const ws = await createTestWorkspace({ brandDir: tempBrandDir(), providers: { scraper }, now: () => NOW, config: { budgets: { scrapingMonthlyUsd: 2 } } });
    const res = await runCompetitorScan(ws);
    // $2 over 21 days left at $0.05 per creator = 1 creator today
    expect(calls).toHaveLength(1);
    expect(res.scanned).toBe(1);
  });

  it("needs the platform-terms acknowledgement for scraping providers", async () => {
    const { scraper, calls } = fakeScraper(library(), { id: "apify" });
    const ws = await createTestWorkspace({ brandDir: tempBrandDir(), providers: { scraper }, now: () => NOW });
    const res = await runCompetitorScan(ws);
    expect(res.skipped).toBe("needs_acknowledgement");
    expect(calls).toEqual([]);
    const ok = await createTestWorkspace({ brandDir: tempBrandDir(), providers: { scraper }, now: () => NOW, config: { acknowledgements: { scrapingTerms: true } } });
    expect((await runCompetitorScan(ok)).scanned).toBe(3);
  });

  it("keeps going when one creator fails and reports it", async () => {
    const { scraper } = fakeScraper(library(), { failFor: ["demo_creator_c"] });
    const ws = await createTestWorkspace({ brandDir: tempBrandDir(), providers: { scraper }, now: () => NOW });
    const res = await runCompetitorScan(ws);
    expect(res.scanned).toBe(2);
    expect(res.failed).toEqual([{ handle: "demo_creator_c", platform: "instagram", reason: "profile is private" }]);
  });

  it("reports when there is no scraper", async () => {
    const ws = await createTestWorkspace({ brandDir: tempBrandDir(), now: () => NOW });
    expect((await runCompetitorScan(ws)).skipped).toBe("no_scraper");
  });
});

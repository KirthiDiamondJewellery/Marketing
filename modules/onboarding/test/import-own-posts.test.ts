import { randomUUID } from "node:crypto";
import { ProviderError, type ExternalPost, type OwnAnalytics, type Platform, type Publisher, type Scraper, type SocialAccount } from "@attentionos/core";
import { enqueueRun } from "@attentionos/module-research";
import { createTestWorkspace, hasTestDatabase, NEEDS_DB } from "@attentionos/module-research/testing";
import { describe, expect, it } from "vitest";
import { importOwnPosts } from "../src/jobs/import-own-posts.ts";
import { voiceReadyJob } from "../src/jobs/voice-ready.ts";
import { listOwnPosts, voiceSourcePosts } from "../src/lib/own-posts.ts";
import { readState, updateState } from "../src/lib/state.ts";

/**
 * Setup's own-post import against a real database (the research test harness) with fake providers: no network.
 * Set ATTENTIONOS_TEST_DATABASE_URL to use another Postgres server. Skips visibly without one (fails under CI).
 */

const HAS_DB = await hasTestDatabase();

const NOW = new Date("2026-10-11T09:00:00Z");

function video(platform: Platform, handle: string, id: string, views: number, caption = `A caption long enough to learn from, number ${id}, about client work.`): ExternalPost {
  return {
    platform,
    platformPostId: id,
    authorHandle: handle,
    url: platform === "tiktok" ? `https://www.tiktok.com/@${handle}/video/${id}` : `https://www.instagram.com/reel/${id}/`,
    publishedAt: new Date(NOW.getTime() - Number(id.replace(/\D/g, "")) * 3_600_000).toISOString(),
    caption,
    views,
    durationS: 40,
    videoUrl: `https://cdn.example.invalid/${id}.mp4`,
  };
}

function fakeScraper(byHandle: Record<string, ExternalPost[]>) {
  const calls: string[] = [];
  const spend: { usd: number }[] = [];
  const scraper: Scraper & { drainSpend(): { usd: number }[] } = {
    id: "apify",
    health: async () => ({ ok: true, detail: "ok" }),
    estimateCostUsd: async (hs) => hs.length * 0.08,
    async listCreatorPosts(handle, platform) {
      calls.push(`${platform}:${handle}`);
      if (platform === "linkedin") throw new ProviderError("apify", "unsupported", "Apify scraping is not set up for linkedin");
      spend.push({ usd: 0.07 });
      return byHandle[`${platform}:${handle}`] ?? [];
    },
    drainSpend: () => spend.splice(0, spend.length),
  };
  return { scraper, calls };
}

function fakeZernio(accounts: SocialAccount[], posts: Record<string, { platformPostId: string; url: string; caption: string; views: number }[]>) {
  const publisher = { id: "zernio", health: async () => ({ ok: true, detail: "ok" }), listAccounts: async () => accounts } as unknown as Publisher;
  const ownAnalytics: OwnAnalytics = {
    id: "zernio",
    health: async () => ({ ok: true, detail: "ok" }),
    listPostMetrics: async (accountId) =>
      (posts[accountId] ?? []).map((p) => ({ ...p, platform: accounts.find((a) => a.providerAccountId === accountId)!.platform, capturedAt: NOW.toISOString(), publishedAt: NOW.toISOString() })),
  };
  return { publisher, ownAnalytics };
}

async function parentRun(ws: Awaited<ReturnType<typeof createTestWorkspace>>): Promise<string> {
  return (await enqueueRun(ws, { jobId: "onboarding.import-own-posts", agent: "analyst", input: {} }))!;
}

describe.skipIf(!HAS_DB)(`importing the owner's own posts${NEEDS_DB}`, () => {
  it("scrapes the owner's handles, stores them as their own, queues the best videos for transcription and records the spend", async () => {
    const ig = Array.from({ length: 20 }, (_, i) => video("instagram", "examplebrand", `ig${i + 1}`, 1000 + i * 100));
    const tt = Array.from({ length: 4 }, (_, i) => video("tiktok", "examplebrand", `tt${i + 1}`, 50_000 + i));
    const { scraper, calls } = fakeScraper({ "instagram:examplebrand": ig, "tiktok:examplebrand": tt });
    const ws = await createTestWorkspace({ now: () => NOW, providers: { scraper }, config: { acknowledgements: { scrapingTerms: true } } });
    await updateState(ws.sql, ws.id, (s) => ({ ...s, data: { ...s.data, content: { ...s.data.content, handles: { instagram: "@examplebrand", tiktok: "https://www.tiktok.com/@examplebrand", linkedin: "in/examplebrand" } } } }));
    const runId = await parentRun(ws);

    const r = await importOwnPosts(ws, { kickoff: "k1", runId });

    expect(calls).toEqual(["instagram:examplebrand", "tiktok:examplebrand", "linkedin:examplebrand"]);
    expect(r.pulled).toBe(24);
    expect(r.byPlatform).toEqual({ instagram: { posts: 20, via: "scraper" }, tiktok: { posts: 4, via: "scraper" } });
    expect(r.notes.join(" ")).toMatch(/LinkedIn in\/examplebrand: nothing imported \(that platform isn't supported\)/);
    expect(r.transcriptionsQueued).toBe(15);
    expect(r.voiceQueued).toBe(false);

    const [creator] = await ws.sql`select tier from tracked_creators where workspace_id = ${ws.id} and platform = 'instagram' and handle = 'examplebrand'`;
    expect(creator?.tier).toBe("own");
    const runs = await ws.sql<{ job_id: string; agent: string; input: { mediaUrl?: string; then?: { jobId: string; input: { kickoff: string } } } }[]>`
      select job_id, agent, input from agent_runs where workspace_id = ${ws.id} and job_id = 'editing.transcribe'`;
    expect(runs).toHaveLength(15);
    expect(runs.every((x) => x.agent === "art_director" && x.input.then?.jobId === "onboarding.voice-ready" && x.input.then.input.kickoff === "k1" && x.input.mediaUrl)).toBe(true);
    // The TikToks (most views) are all in; the weakest Instagram posts are not.
    const queued = (await listOwnPosts(ws.sql, ws.id)).filter((p) => p.transcriptStatus === "queued");
    expect(queued.filter((p) => p.platform === "tiktok")).toHaveLength(4);
    expect(queued.some((p) => p.url.includes("/ig1/"))).toBe(false);
    const [cost] = await ws.sql<{ n: number }[]>`select count(*)::int as n from cost_ledger where workspace_id = ${ws.id} and category = 'scraping'`;
    expect(cost?.n).toBe(2);
    const state = await readState(ws.sql, ws.id);
    expect(state?.data.start.notes.some((n) => n.startsWith("LinkedIn"))).toBe(true);

    // Research never scans the owner's own row as a competitor.
    const { listTrackedCreators } = await import("@attentionos/module-research");
    expect((await listTrackedCreators(ws)).some((c) => c.handle === "examplebrand")).toBe(false);
  });

  it("falls back to the connected account's analytics when scraping isn't allowed, and goes straight to the voice step", async () => {
    const { scraper, calls } = fakeScraper({});
    const zernio = fakeZernio([{ providerAccountId: "acc-ig", platform: "instagram", handle: "examplebrand", status: "connected" }], {
      "acc-ig": [
        { platformPostId: "z1", url: "https://www.instagram.com/p/z1/", caption: "Most firms post to be seen. We post to be booked, and here is the difference.", views: 900 },
        { platformPostId: "z2", url: "https://www.instagram.com/p/z2/", caption: "Short.", views: 10 },
      ],
    });
    const ws = await createTestWorkspace({ now: () => NOW, providers: { scraper, ...zernio }, config: { acknowledgements: { scrapingTerms: false } } });
    const runId = await parentRun(ws);

    const r = await importOwnPosts(ws, { kickoff: "k2", runId, handles: { instagram: "examplebrand" } });

    expect(calls).toEqual([]);
    expect(r.byPlatform).toEqual({ instagram: { posts: 2, via: "analytics" } });
    expect(r.notes.join(" ")).toMatch(/paused until you accept the scraping notice/);
    expect(r.ownSyncQueued).toBe(true);
    // No media links and a scraper that can't download: nothing to transcribe, so the voice step starts from captions.
    expect(r.transcriptionsQueued).toBe(0);
    expect(r.voiceQueued).toBe(true);
    const [sync] = await ws.sql<{ input: { backfill: boolean } }[]>`select input from agent_runs where workspace_id = ${ws.id} and job_id = 'research.own-sync'`;
    expect(sync?.input.backfill).toBe(true);
  });

  it("says plainly when nothing can be imported", async () => {
    const ws = await createTestWorkspace({ now: () => NOW });
    const r = await importOwnPosts(ws, { kickoff: "k3", runId: await parentRun(ws), handles: { instagram: "examplebrand" } });
    expect(r.pulled).toBe(0);
    expect(r.notes).toEqual(["Instagram @examplebrand: nothing imported (connect Apify or Zernio to bring them in)."]);
    // Nothing to transcribe: the voice step is asked to start (it will explain there aren't enough posts).
    expect(r.voiceQueued).toBe(true);
  });
});

describe.skipIf(!HAS_DB)(`the owner's follower count${NEEDS_DB}`, () => {
  const profiled = (followers: Record<string, number>) => {
    const { scraper, calls } = fakeScraper({
      "instagram:examplebrand": [video("instagram", "examplebrand", "ig1", 500)],
      "tiktok:examplebrand": [video("tiktok", "examplebrand", "tt1", 900)],
    });
    const asks: { key: string; maxUsd?: number }[] = [];
    const withProfile: Scraper = {
      ...scraper,
      async fetchProfile(handle, platform, o) {
        asks.push({ key: `${platform}:${handle}`, ...(o?.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}) });
        const n = followers[`${platform}:${handle}`];
        if (n === undefined) throw new ProviderError("apify", "upstream", "profile actor failed");
        return { platform, handle, followers: n, following: 12, posts: 40, capturedAt: NOW.toISOString() };
      },
    };
    return { scraper: withProfile, calls, asks };
  };

  it("records followers from the same scan, so Analytics shows them with no analytics provider", async () => {
    const { scraper, asks } = profiled({ "instagram:examplebrand": 23_140 });
    const ws = await createTestWorkspace({ now: () => NOW, providers: { scraper }, config: { acknowledgements: { scrapingTerms: true }, budgets: { scrapingMonthlyUsd: 5 } } });
    const progress: string[] = [];
    const r = await importOwnPosts(ws, { kickoff: "kf", runId: await parentRun(ws), handles: { instagram: "@examplebrand", tiktok: "examplebrand" }, progress: async (m) => void progress.push(m) });

    // Instagram's count landed; TikTok's read failed and the import carried on.
    expect(r.byPlatform).toEqual({ instagram: { posts: 1, via: "scraper", followers: 23_140 }, tiktok: { posts: 1, via: "scraper" } });
    expect(progress).toContain("Your followers: 23,140 on Instagram");
    // The budget left after the post run's estimate is passed down ($5 - $0.08).
    expect(asks[0]!.key).toBe("instagram:examplebrand");
    expect(asks[0]!.maxUsd).toBeCloseTo(5 - 0.08, 6);
    const snaps = await ws.sql`
      select s.followers, s.following, s.posts_count, s.source, s.day::text as day, a.provider, a.status, a.platform, a.handle
        from account_snapshots s join social_accounts a on a.id = s.social_account_id where s.workspace_id = ${ws.id}`;
    expect(snaps).toEqual([{ followers: "23140", following: "12", posts_count: 40, source: "scan", day: "2026-10-11", provider: "scan", status: "disabled", platform: "instagram", handle: "examplebrand" }]);

    const { followerGrowth } = await import("@attentionos/module-learn/analytics");
    expect(await followerGrowth(ws)).toMatchObject({ current: 23_140, lastDay: "2026-10-11" });

    // A re-scan the same day updates the reading instead of adding one.
    await importOwnPosts(ws, { kickoff: "kf2", runId: await parentRun(ws), handles: { instagram: "examplebrand" } });
    const [n] = await ws.sql<{ n: number }[]>`select count(*)::int as n from account_snapshots where workspace_id = ${ws.id}`;
    expect(n?.n).toBe(1);
  });

  it("writes onto the connected account when the publishing service already lists the handle", async () => {
    const { scraper } = profiled({ "instagram:examplebrand": 9_000 });
    const ws = await createTestWorkspace({ now: () => NOW, providers: { scraper }, config: { acknowledgements: { scrapingTerms: true } } });
    const [acct] = await ws.sql`insert into social_accounts (workspace_id, provider, provider_account_id, platform, handle) values (${ws.id}, 'zernio', 'acc-ig', 'instagram', '@ExampleBrand') returning id`;
    await importOwnPosts(ws, { kickoff: "kz", runId: await parentRun(ws), handles: { instagram: "examplebrand" } });
    const rows = await ws.sql`select social_account_id, followers from account_snapshots where workspace_id = ${ws.id}`;
    expect(rows).toEqual([{ social_account_id: acct!.id, followers: "9000" }]);
    const [placeholders] = await ws.sql<{ n: number }[]>`select count(*)::int as n from social_accounts where workspace_id = ${ws.id} and provider = 'scan'`;
    expect(placeholders?.n).toBe(0);
  });
});

describe.skipIf(!HAS_DB)(`the voice step waits for transcripts${NEEDS_DB}`, () => {
  it("starts the voice profile once, after the last own transcript lands (or when forced)", async () => {
    const posts = Array.from({ length: 3 }, (_, i) => video("instagram", "qf", `v${i + 1}`, 100 * (i + 1)));
    const { scraper } = fakeScraper({ "instagram:qf": posts });
    const ws = await createTestWorkspace({ now: () => NOW, providers: { scraper }, config: { acknowledgements: { scrapingTerms: true } } });
    const runId = await parentRun(ws);
    await importOwnPosts(ws, { kickoff: "k4", runId, handles: { instagram: "@qf" } });
    const ctx = (input: { kickoff: string; force?: boolean }) => ({
      ws,
      input: { force: false, ...input },
      actor: "system" as const,
      runId,
      log: ws.log,
      signal: new AbortController().signal,
      progress: async () => {},
    });
    const voiceRuns = async () => (await ws.sql<{ n: number }[]>`select count(*)::int as n from agent_runs where workspace_id = ${ws.id} and job_id = 'onboarding.voice-profile'`)[0]!.n;

    expect(await voiceReadyJob.run(ctx({ kickoff: "k4" }))).toEqual({ waiting: 3 });
    expect(await voiceRuns()).toBe(0);

    // Two transcripts land, one fails: nothing pending any more.
    const own = await listOwnPosts(ws.sql, ws.id);
    await ws.sql`update external_posts set transcript = ${"So here is the thing nobody tells you about booking calls from short videos."}, transcript_status = 'done' where id = ${own[0]!.id}`;
    await ws.sql`update external_posts set transcript = ${"Three steps. First, say the problem the way your client says it."}, transcript_status = 'done' where id = ${own[1]!.id}`;
    await ws.sql`update external_posts set transcript_status = 'failed' where id = ${own[2]!.id}`;

    expect(await voiceReadyJob.run(ctx({ kickoff: "k4" }))).toEqual({ queued: true, pending: 0 });
    expect(await voiceReadyJob.run(ctx({ kickoff: "k4" }))).toEqual({ skipped: "already_queued" });
    expect(await voiceReadyJob.run(ctx({ kickoff: "k4", force: true }))).toEqual({ skipped: "already_queued" });
    expect(await voiceRuns()).toBe(1);

    // Transcripts come first, with the caption alongside.
    const sources = await voiceSourcePosts(ws.sql, ws.id);
    expect(sources.map((s) => s.kind)).toEqual(["transcript", "transcript", "caption"]);
    expect(sources[0]!.text).toMatch(/Caption: A caption long enough/);
  });

  it("a forced check starts the draft even with transcripts still pending", async () => {
    const { scraper } = fakeScraper({ "instagram:qf2": [video("instagram", "qf2", "w1", 5)] });
    const ws = await createTestWorkspace({ id: randomUUID(), now: () => NOW, providers: { scraper }, config: { acknowledgements: { scrapingTerms: true } } });
    const runId = await parentRun(ws);
    await importOwnPosts(ws, { kickoff: "k5", runId, handles: { instagram: "qf2" } });
    const r = await voiceReadyJob.run({ ws, input: { kickoff: "k5", force: true }, actor: "system", runId, log: ws.log, signal: new AbortController().signal, progress: async () => {} });
    expect(r).toEqual({ queued: true, pending: 1 });
  });
});

import { defineNativeJob, PLATFORMS, ProviderError, type CreatorProfile, type ExternalPost, type Platform, type Scraper, type SocialAccount, type WorkspaceContext } from "@attentionos/core";
import { recordScanFollowers } from "@attentionos/module-learn/followers";
import { enqueueRun, recordCost, researchSettings, scrapingBudgetUsed, transcriptionRequestSchema, REPLY_TO } from "@attentionos/module-research";
import { z } from "zod";
import { bareHandle, ownHandleList, PLATFORM_NAMES } from "../lib/handles.ts";
import {
  ensureOwnCreator,
  externalFromSnapshot,
  listOwnPosts,
  markTranscriptQueued,
  OWN_POST_LIMIT,
  OWN_TRANSCRIBE_LIMIT,
  pickForTranscription,
  upsertOwnPosts,
} from "../lib/own-posts.ts";
import { readState, updateState } from "../lib/state.ts";

export const VOICE_READY_JOB = "onboarding.voice-ready";
export const VOICE_PROFILE_JOB = "onboarding.voice-profile";

export const importOwnPostsInput = z.object({
  /** One id per press of "Start" in setup; keys the follow-up work so it runs once. */
  kickoff: z.string().max(40).default("manual"),
  /** Defaults to the handles saved in setup. */
  handles: z.partialRecord(z.enum(PLATFORMS), z.string().max(120)).optional(),
});

/** Scrapers that read public pages (rather than an official API) need the platform-terms acknowledgement. */
const NEEDS_TERMS_ACK = new Set(["apify", "ytdlp"]);

type SpendAware = { drainSpend(): { usd: number; estimated?: boolean }[] };
const isSpendAware = (s: Scraper): s is Scraper & SpendAware => typeof (s as Partial<SpendAware>).drainSpend === "function";

export type ImportOutcome = {
  pulled: number;
  added: number;
  byPlatform: Partial<Record<Platform, { posts: number; via: "scraper" | "analytics"; followers?: number }>>;
  notes: string[];
  transcriptionsQueued: number;
  ownSyncQueued: boolean;
  voiceQueued: boolean;
};

function reasonOf(err: unknown): string {
  if (err instanceof ProviderError) {
    // Adapters say "X is not set" / "add X to your .env" when there's no key at all.
    if (err.code === "auth") return /not set|add [A-Z0-9_]+ to/i.test(err.message) ? "no key is set yet" : "the key wasn't accepted";
    if (err.code === "unsupported") return "that platform isn't supported";
    if (err.code === "budget_exceeded") return "the scraping budget is used up";
    if (err.code === "rate_limited") return "the service asked us to slow down";
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^\[[^\]]+\]\s*\w+:\s*/, "").split("\n")[0]!.slice(0, 140);
}

/**
 * Reads one of the owner's handles through the scraper, inside the monthly scraping budget. When the scraper can read
 * account numbers, the follower count comes along (free on TikTok and YouTube, one small run on Instagram).
 */
async function scrapeOwn(ws: WorkspaceContext, scraper: Scraper, platform: Platform, handle: string, runId: string): Promise<{ posts: ExternalPost[]; profile: CreatorProfile | null } | { problem: string }> {
  const limitUsd = ws.config.budgets.scrapingMonthlyUsd;
  const estimate = await scraper.estimateCostUsd([{ handle: bareHandle(handle), platform }], { limit: OWN_POST_LIMIT });
  const used = await scrapingBudgetUsed(ws, scraper);
  if (used + estimate > limitUsd) return { problem: `the scraping budget ($${limitUsd}/month) is used up` };
  try {
    const posts = await scraper.listCreatorPosts(bareHandle(handle), platform, { limit: OWN_POST_LIMIT });
    let profile: CreatorProfile | null = null;
    if (posts.length && scraper.fetchProfile) {
      // Followers are a nice-to-have here: a failed read never fails the import.
      profile = await scraper.fetchProfile(bareHandle(handle), platform, { maxUsd: Math.max(0, limitUsd - used - estimate) }).catch((err: unknown) => {
        ws.log.debug("own follower count not read", { platform, reason: reasonOf(err) });
        return null;
      });
    }
    return { posts, profile };
  } catch (err) {
    return { problem: reasonOf(err) };
  } finally {
    const records = isSpendAware(scraper) ? scraper.drainSpend() : estimate > 0 ? [{ usd: estimate, estimated: true }] : [];
    for (const r of records) await recordCost(ws, { category: "scraping", provider: scraper.id, usd: r.usd, runId, detail: { ...r, creator: `${platform}:${bareHandle(handle)}`, own: true } });
  }
}

/** Recent posts of one connected account from the publishing service's analytics. */
async function fromAnalytics(ws: WorkspaceContext, account: SocialAccount, handle: string): Promise<ExternalPost[]> {
  const snaps = await ws.providers.ownAnalytics!.listPostMetrics(account.providerAccountId, { limit: OWN_POST_LIMIT });
  return snaps.map((s) => externalFromSnapshot(s, handle)).filter((p): p is ExternalPost => Boolean(p));
}

export async function importOwnPosts(ws: WorkspaceContext, opts: { kickoff: string; runId: string; handles?: Partial<Record<Platform, string>>; progress?: (m: string) => Promise<void> }): Promise<ImportOutcome> {
  const progress = opts.progress ?? (async () => {});
  const out: ImportOutcome = { pulled: 0, added: 0, byPlatform: {}, notes: [], transcriptionsQueued: 0, ownSyncQueued: false, voiceQueued: false };
  const state = await readState(ws.sql, ws.id);
  const handles = ownHandleList(opts.handles ?? state?.data.content.handles ?? {});
  if (!handles.length) {
    out.notes.push("No handles were given, so there were no posts to bring in.");
    return out;
  }

  const scraper = ws.providers.scraper;
  const scraperOk = Boolean(scraper) && (!NEEDS_TERMS_ACK.has(scraper!.id) || ws.config.acknowledgements.scrapingTerms);
  if (scraper && !scraperOk) out.notes.push("Reading public posts is paused until you accept the scraping notice (Competitors step).");

  let accounts: SocialAccount[] = [];
  if (ws.providers.publisher && ws.providers.ownAnalytics) {
    accounts = await ws.providers.publisher.listAccounts().catch((err: unknown) => {
      out.notes.push(`Couldn't list your connected accounts (${reasonOf(err)}).`);
      return [];
    });
  }

  for (const { platform, handle } of handles) {
    if (opts.progress && handles.length > 1) await progress(`Reading your ${PLATFORM_NAMES[platform]} posts`);
    let posts: ExternalPost[] = [];
    let via: "scraper" | "analytics" = "scraper";
    let profile: CreatorProfile | null = null;
    const problems: string[] = [];
    // The scraper first: it returns view counts and direct video links, which transcription needs.
    if (scraper && scraperOk) {
      const r = await scrapeOwn(ws, scraper, platform, handle, opts.runId);
      if ("posts" in r) ({ posts, profile } = r);
      else problems.push(r.problem);
    }
    if (!posts.length) {
      const account = accounts.find((a) => a.platform === platform && a.status === "connected" && bareHandle(a.handle) === bareHandle(handle))
        ?? accounts.find((a) => a.platform === platform && a.status === "connected");
      if (account) {
        try {
          posts = await fromAnalytics(ws, account, handle);
          via = "analytics";
        } catch (err) {
          problems.push(reasonOf(err));
        }
      }
    }
    if (!posts.length) {
      const why = problems[0] ?? (scraper || accounts.length ? "no posts came back" : "connect Apify or Zernio to bring them in");
      out.notes.push(`${PLATFORM_NAMES[platform]} ${handle}: nothing imported (${why}).`);
      continue;
    }
    const creatorId = await ensureOwnCreator(ws, platform, handle);
    const stored = await upsertOwnPosts(ws, creatorId, posts.map((p) => ({ ...p, authorHandle: p.authorHandle || bareHandle(handle) })));
    out.pulled += stored.stored;
    out.added += stored.added;
    out.byPlatform[platform] = { posts: stored.stored, via };
    // Today's follower count, so Analytics shows it before any analytics provider reports one.
    if (profile && via === "scraper") {
      const saved = await recordScanFollowers(ws, { ...profile, handle: bareHandle(handle) }, { scraper: scraper!.id }).catch((err: unknown) => {
        ws.log.warn("own follower count not saved", { platform, reason: reasonOf(err) });
        return null;
      });
      if (saved && typeof profile.followers === "number") out.byPlatform[platform]!.followers = profile.followers;
    }
  }

  if (out.pulled) {
    const where = Object.keys(out.byPlatform).map((p) => PLATFORM_NAMES[p as Platform]);
    await progress(`Pulled ${out.pulled} of your posts from ${where.join(", ")}`);
    const counts = Object.entries(out.byPlatform)
      .filter(([, v]) => typeof v.followers === "number")
      .map(([p, v]) => `${v.followers!.toLocaleString("en-US")} on ${PLATFORM_NAMES[p as Platform]}`);
    if (counts.length) await progress(`Your followers: ${counts.join(", ")}`);
  }

  // Real numbers for your own posts (reach, saves, watch time) come from the analytics provider's own sync.
  if (ws.providers.ownAnalytics && accounts.length) {
    out.ownSyncQueued = Boolean(await enqueueRun(ws, { jobId: "research.own-sync", agent: "analyst", input: { backfill: true }, dedupeKey: `onboarding:own-sync:${opts.kickoff}`, parentRunId: opts.runId, createdBy: "agent:analyst" }));
  }

  // Transcribe the best videos (research → editing hand-off); each one checks in with the voice step when it lands.
  const then = { jobId: VOICE_READY_JOB, agent: "copywriter" as const, input: { kickoff: opts.kickoff } };
  const editingOn = ws.config.modules["editing"]?.enabled !== false;
  const pick = editingOn ? pickForTranscription(await listOwnPosts(ws.sql, ws.id), OWN_TRANSCRIBE_LIMIT, { canDownload: typeof scraper?.downloadMedia === "function" }) : [];
  if (!editingOn && out.pulled) out.notes.push("The editing module is off, so videos aren't transcribed; your voice is learned from captions.");
  const jobId = researchSettings(ws).competitorScan.transcribeJobId;
  for (const p of pick) {
    const input = transcriptionRequestSchema.parse({
      kind: "external_post",
      externalPostId: p.id,
      url: p.url,
      ...(p.videoUrl ? { mediaUrl: p.videoUrl } : {}),
      destDir: `research/${p.id}`,
      replyTo: REPLY_TO,
      then,
    });
    const id = await enqueueRun(ws, { jobId, agent: "art_director", input, dedupeKey: `transcribe:external_post:${p.id}`, parentRunId: opts.runId, createdBy: "agent:analyst" });
    if (id) {
      await markTranscriptQueued(ws.sql, ws.id, p.id);
      out.transcriptionsQueued++;
    }
  }
  if (out.transcriptionsQueued) {
    await progress(`Sent ${out.transcriptionsQueued} of your best videos for transcription (up to ${OWN_TRANSCRIBE_LIMIT})`);
  } else {
    // Nothing to wait for: the voice step can start from captions now.
    out.voiceQueued = Boolean(await enqueueRun(ws, { jobId: VOICE_READY_JOB, agent: "copywriter", input: { kickoff: opts.kickoff, force: true }, parentRunId: opts.runId, createdBy: "agent:analyst" }));
  }

  await updateState(ws.sql, ws.id, (s) => (s.data.start.kickoff && s.data.start.kickoff !== opts.kickoff ? s : { ...s, data: { ...s.data, start: { ...s.data.start, notes: [...new Set([...s.data.start.notes, ...out.notes])].slice(-12) } } }));
  return out;
}

/**
 * Setup's own-post import: reads the owner's handles through the scraper (recent posts with views and video links),
 * falling back to the publishing service's analytics for connected accounts. Posts land in `external_posts` under the
 * owner's `own` creator row; the best videos are queued for transcription, and the voice profile follows once they
 * are in. Anything that can't be imported is reported in plain words and skipped.
 */
export const importOwnPostsJob = defineNativeJob({
  kind: "native",
  id: "onboarding.import-own-posts",
  agent: "analyst",
  description: "Brings in your own recent posts so the team can learn your voice and your numbers.",
  input: importOwnPostsInput,
  timeoutMs: 30 * 60_000,
  async run(ctx) {
    const r = await importOwnPosts(ctx.ws, { kickoff: ctx.input.kickoff, runId: ctx.runId, ...(ctx.input.handles ? { handles: ctx.input.handles } : {}), progress: (m) => ctx.progress(m) });
    if (!r.pulled) await ctx.progress(r.notes[0] ?? "None of your posts could be brought in yet");
    return r;
  },
});

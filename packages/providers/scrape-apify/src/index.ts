import { z } from "zod";
import {
  ProviderError,
  type AttentionOSConfig, type CreatorProfile, type ExternalPost, type Logger, type Platform, type ProviderHealth, type Scraper,
} from "@attentionos/core";
import { create as createYtdlp } from "@attentionos/provider-scrape-ytdlp";
import { requestJson, type FetchLike } from "@attentionos/provider-shared";
import {
  parseInstagramItem, parseInstagramProfile, parseTiktokItem, parseTiktokProfile, parseYoutubeItem, parseYoutubeProfile,
} from "./parse.ts";

export {
  parseInstagramItem, parseTiktokItem, parseYoutubeItem, parseDuration, parseInstagramProfile, parseTiktokProfile, parseYoutubeProfile,
} from "./parse.ts";

/**
 * Scraper over the Apify REST API v2 (https://docs.apify.com/api/v2).
 *
 * Flow per creator: POST /v2/acts/{actorId}/runs?waitForFinish=60 → poll GET /v2/actor-runs/{runId}?waitForFinish=60
 * until a terminal status → GET /v2/datasets/{datasetId}/items?clean=true. The finished run reports its real
 * cost in `usageTotalUsd`; that is queued as a spend record the research module writes to `cost_ledger`.
 *
 * Budget: the research module checks `budgets.scrapingMonthlyUsd` BEFORE calling `listCreatorPosts`, using
 * `estimateCostUsd` plus month-to-date spend (and `accountUsageUsd()` from GET /v2/users/me/limits when available).
 *
 * Account numbers (`fetchProfile`): TikTok and YouTube post items already carry the author's follower counts, so a
 * profile read right after `listCreatorPosts` for the same handle is free. Instagram reel items don't, so Instagram
 * runs `apify/instagram-profile-scraper` once (one dataset item, about a cent).
 *
 * Secrets: APIFY_TOKEN.
 */

export const PROVIDER_ID = "apify";
const API = "https://api.apify.com/v2";

export type ActorConfig = {
  /** Actor id in `username~actor-name` form. */
  actorId: string;
  /** USD per 1,000 dataset items, from the actor's pricing page. Used for estimates only. */
  usdPer1000Results: number;
  /** Fixed USD per run (actor start / compute floor). */
  usdPerRun: number;
};

const actorSchema = z.object({
  actorId: z.string().regex(/^[\w.-]+[~/][\w.-]+$/),
  usdPer1000Results: z.number().nonnegative(),
  usdPerRun: z.number().nonnegative().default(0),
});

/**
 * Defaults are well-known public actors. Prices are the listed pay-per-result rates at the time of writing
 * and are deliberately on the high side; override them in `modules.research.settings.apify.actors`.
 */
export const DEFAULT_ACTORS: Partial<Record<Platform, ActorConfig>> = {
  instagram: { actorId: "apify~instagram-reel-scraper", usdPer1000Results: 2.7, usdPerRun: 0.005 },
  tiktok: { actorId: "clockworks~tiktok-scraper", usdPer1000Results: 4, usdPerRun: 0.005 },
  youtube: { actorId: "streamers~youtube-scraper", usdPer1000Results: 5, usdPerRun: 0.005 },
};

/**
 * Actors for account numbers where the post actor's items don't include them. Platforms without an entry here read
 * the counts off a one-item run of their post actor.
 */
export const DEFAULT_PROFILE_ACTORS: Partial<Record<Platform, ActorConfig>> = {
  instagram: { actorId: "apify~instagram-profile-scraper", usdPer1000Results: 2.6, usdPerRun: 0.005 },
};

/** A profile read by a recent post run is reused for this long. */
const PROFILE_CACHE_MS = 60 * 60_000;

const settingsSchema = z.object({
  actors: z.partialRecord(z.enum(["instagram", "tiktok", "youtube"]), actorSchema).default({}),
  profileActors: z.partialRecord(z.enum(["instagram", "tiktok", "youtube"]), actorSchema).default({}),
  defaultLimit: z.number().int().positive().max(200).default(12),
  /** Hard ceiling for one actor run. */
  runTimeoutMs: z.number().int().positive().default(300_000),
});

export type SpendRecord = {
  usd: number; estimated: boolean; actorId: string; runId?: string; handle: string; platform: Platform; items: number;
  /** Set on account-number runs (`fetchProfile`); post runs leave it out. */
  kind?: "profile";
};

/** Extra capabilities beyond the core Scraper contract. The research module detects them with `in`. */
export interface ApifyScraper extends Scraper {
  /** Spend from finished runs since the last call; the caller writes them to `cost_ledger`. */
  drainSpend(): SpendRecord[];
  /** Month-to-date platform usage on the Apify account (free to call). */
  accountUsageUsd(): Promise<{ usedUsd: number; limitUsd?: number }>;
  /** Downloads a post's video with yt-dlp (Apify only returns direct links for some platforms). */
  downloadMedia(post: ExternalPost, destDir: string): Promise<{ localPath: string }>;
  /** Follower / following / post counts for one handle (free after a post run on TikTok and YouTube). */
  fetchProfile(handle: string, platform: Platform, opts?: { maxUsd?: number }): Promise<CreatorProfile | null>;
}

type RunData = { id: string; status: string; defaultDatasetId: string; usageTotalUsd?: number; statusMessage?: string };

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

export type ApifyOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  fetch?: FetchLike;
  /** Override actors directly (tests, advanced setups). */
  actors?: Partial<Record<Platform, ActorConfig>>;
  profileActors?: Partial<Record<Platform, ActorConfig>>;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export function create(opts: ApifyOptions): ApifyScraper {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const settings = settingsSchema.parse((opts.config.modules["research"]?.settings as { apify?: unknown } | undefined)?.apify ?? {});
  const actors: Partial<Record<Platform, ActorConfig>> = { ...DEFAULT_ACTORS, ...settings.actors, ...(opts.actors ?? {}) };
  const profileActors: Partial<Record<Platform, ActorConfig>> = { ...DEFAULT_PROFILE_ACTORS, ...settings.profileActors, ...(opts.profileActors ?? {}) };
  const now = opts.now ?? (() => new Date());
  const spend: SpendRecord[] = [];
  const profiles = new Map<string, CreatorProfile>();
  const profileKey = (platform: Platform, handle: string) => `${platform}:${handle.replace(/^@/, "").toLowerCase()}`;
  const log = opts.log.child({ provider: PROVIDER_ID });

  const token = () => {
    const t = opts.secret("APIFY_TOKEN") ?? opts.secret("APIFY_API_TOKEN");
    if (!t) throw new ProviderError(PROVIDER_ID, "auth", "APIFY_TOKEN is not set. Add it to your workspace .env (Apify console → Settings → API & Integrations).");
    return t;
  };
  const headers = () => ({ Authorization: `Bearer ${token()}`, "Content-Type": "application/json" });

  const actorFor = (platform: Platform): ActorConfig => {
    const a = actors[platform];
    if (!a) throw new ProviderError(PROVIDER_ID, "unsupported", `no Apify actor configured for ${platform}`);
    return a;
  };

  function inputFor(platform: Platform, handle: string, limit: number): Record<string, unknown> {
    const h = handle.replace(/^@/, "");
    switch (platform) {
      case "instagram":
        return { username: [h], resultsLimit: limit };
      case "tiktok":
        return { profiles: [h], resultsPerPage: limit, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false };
      case "youtube":
        return { startUrls: [{ url: `https://www.youtube.com/@${h}/shorts` }], maxResults: 0, maxResultsShorts: limit, maxResultStreams: 0 };
      default:
        throw new ProviderError(PROVIDER_ID, "unsupported", `Apify scraping is not set up for ${platform}`);
    }
  }

  const parserFor = (platform: Platform) =>
    platform === "instagram" ? parseInstagramItem : platform === "tiktok" ? parseTiktokItem : parseYoutubeItem;
  const profileParserFor = (platform: Platform) =>
    platform === "instagram" ? parseInstagramProfile : platform === "tiktok" ? parseTiktokProfile : platform === "youtube" ? parseYoutubeProfile : null;

  /** The first item that carries account numbers for this handle. */
  function profileFrom(platform: Platform, handle: string, items: unknown[]): CreatorProfile | null {
    const parse = profileParserFor(platform);
    if (!parse) return null;
    const at = now().toISOString();
    for (const raw of items) {
      const p = parse(raw, handle, at);
      if (p) return p;
    }
    return null;
  }

  async function runActor(actor: ActorConfig, input: Record<string, unknown>): Promise<{ run: RunData; items: unknown[] }> {
    const deadline = Date.now() + settings.runTimeoutMs;
    const started = await requestJson<{ data: RunData }>(fetchImpl, `${API}/acts/${encodeURIComponent(actor.actorId)}/runs?waitForFinish=60`, {
      provider: PROVIDER_ID, method: "POST", headers: headers(), body: JSON.stringify(input), timeoutMs: 90_000,
    });
    let run = started.data;
    while (!TERMINAL.has(run.status)) {
      if (Date.now() > deadline) {
        await requestJson(fetchImpl, `${API}/actor-runs/${run.id}/abort`, { provider: PROVIDER_ID, method: "POST", headers: headers() }).catch(() => undefined);
        throw new ProviderError(PROVIDER_ID, "upstream", `actor ${actor.actorId} did not finish within ${Math.round(settings.runTimeoutMs / 1000)}s`);
      }
      if (opts.sleep) await opts.sleep(1000);
      run = (await requestJson<{ data: RunData }>(fetchImpl, `${API}/actor-runs/${run.id}?waitForFinish=60`, { provider: PROVIDER_ID, headers: headers(), timeoutMs: 90_000 })).data;
    }
    if (run.status !== "SUCCEEDED") {
      throw new ProviderError(PROVIDER_ID, "upstream", `actor ${actor.actorId} ended with ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""}`, { vendorCode: run.status });
    }
    const items = await requestJson<unknown[]>(fetchImpl, `${API}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, { provider: PROVIDER_ID, headers: headers(), timeoutMs: 60_000 });
    return { run, items: Array.isArray(items) ? items : [] };
  }

  const estimateOne = (platform: Platform, limit: number) => {
    const a = actors[platform];
    return a ? a.usdPerRun + (limit * a.usdPer1000Results) / 1000 : 0;
  };

  return {
    id: PROVIDER_ID,

    async health(): Promise<ProviderHealth> {
      if (!(opts.secret("APIFY_TOKEN") ?? opts.secret("APIFY_API_TOKEN"))) {
        return { ok: false, detail: "No Apify token", fix: "Copy your API token from the Apify console (Settings → API & Integrations) into APIFY_TOKEN in .env" };
      }
      try {
        const me = await requestJson<{ data: { username?: string } }>(fetchImpl, `${API}/users/me`, { provider: PROVIDER_ID, headers: headers(), timeoutMs: 15_000 });
        return { ok: true, detail: `Connected to Apify as ${me.data.username ?? "your account"}` };
      } catch (err) {
        const e = err as ProviderError;
        return {
          ok: false,
          detail: e.code === "auth" ? "Apify rejected the token" : `Could not reach Apify (${e.message})`,
          fix: "Copy your API token from the Apify console (Settings → API & Integrations) into APIFY_TOKEN in .env",
        };
      }
    },

    // Apify gives direct video links for Instagram reels but rarely for TikTok and never for YouTube, so
    // transcription downloads from the public post URL with yt-dlp (installed in the AttentionOS image).
    async downloadMedia(post, destDir) {
      return createYtdlp({ secret: opts.secret, config: opts.config, log: opts.log }).downloadMedia(post, destDir);
    },

    async estimateCostUsd(handles, o) {
      const limit = o?.limit ?? settings.defaultLimit;
      return handles.reduce((sum, h) => sum + estimateOne(h.platform, limit), 0);
    },

    async listCreatorPosts(handle, platform, o) {
      const actor = actorFor(platform);
      const limit = o?.limit ?? settings.defaultLimit;
      const { run, items } = await runActor(actor, inputFor(platform, handle, limit));
      const parse = parserFor(platform);
      const posts: ExternalPost[] = [];
      for (const raw of items) {
        const p = parse(raw, handle);
        if (p && (!o?.since || p.publishedAt >= o.since)) posts.push(p);
      }
      const usd = typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : estimateOne(platform, items.length);
      spend.push({ usd, estimated: typeof run.usageTotalUsd !== "number", actorId: actor.actorId, runId: run.id, handle, platform, items: items.length });
      const profile = profileFrom(platform, handle, items);
      if (profile) profiles.set(profileKey(platform, handle), profile);
      log.debug("apify run finished", { actor: actor.actorId, items: items.length, kept: posts.length, usd });
      return posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    },

    async fetchProfile(handle, platform, o) {
      const key = profileKey(platform, handle);
      const cached = profiles.get(key);
      if (cached && now().getTime() - Date.parse(cached.capturedAt) < PROFILE_CACHE_MS) return cached;
      // A dedicated profile actor when one is set; otherwise a one-item run of the post actor.
      const dedicated = profileActors[platform];
      const actor = dedicated ?? actorFor(platform);
      const input = dedicated
        ? (platform === "instagram" ? { usernames: [handle.replace(/^@/, "")] } : { profiles: [handle.replace(/^@/, "")] })
        : inputFor(platform, handle, 1);
      const estimate = actor.usdPerRun + actor.usdPer1000Results / 1000;
      if (o?.maxUsd !== undefined && estimate > o.maxUsd) {
        throw new ProviderError(PROVIDER_ID, "budget_exceeded", `reading ${platform} account numbers costs about $${estimate.toFixed(3)}, more than the $${Math.max(0, o.maxUsd).toFixed(3)} left`);
      }
      const { run, items } = await runActor(actor, input);
      const usd = typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : actor.usdPerRun + (items.length * actor.usdPer1000Results) / 1000;
      spend.push({ usd, estimated: typeof run.usageTotalUsd !== "number", actorId: actor.actorId, runId: run.id, handle, platform, items: items.length, kind: "profile" });
      const profile = profileFrom(platform, handle, items);
      if (profile) profiles.set(key, profile);
      log.debug("apify profile run finished", { actor: actor.actorId, found: Boolean(profile), usd });
      return profile;
    },

    drainSpend() {
      return spend.splice(0, spend.length);
    },

    async accountUsageUsd() {
      const r = await requestJson<{ data: { current?: { monthlyUsageUsd?: number }; limits?: { maxMonthlyUsageUsd?: number } } }>(
        fetchImpl, `${API}/users/me/limits`, { provider: PROVIDER_ID, headers: headers(), timeoutMs: 15_000 });
      return {
        usedUsd: r.data.current?.monthlyUsageUsd ?? 0,
        ...(typeof r.data.limits?.maxMonthlyUsageUsd === "number" ? { limitUsd: r.data.limits.maxMonthlyUsageUsd } : {}),
      };
    },
  };
}

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProviderError, type DmAutomationRequest, type Platform, type PostMetricsSnapshot, type ProviderErrorCode, type PublishRequest,
  type PublishResult, type SocialAccount,
} from "@attentionos/core";

/**
 * Pure request/response mapping for the Zernio REST API v1 (https://docs.zernio.com, OpenAPI at
 * https://zernio.com/openapi.json). Field names follow the spec; see docs/providers/zernio.md for the open questions.
 */

export const PROVIDER = "zernio";
export const BASE_URL = "https://zernio.com/api/v1";

/** Zernio calls X "twitter". Zernio supports more platforms than AttentionOS; the rest are skipped. */
export const TO_ZERNIO: Record<Platform, string> = {
  instagram: "instagram", tiktok: "tiktok", youtube: "youtube", facebook: "facebook", linkedin: "linkedin", x: "twitter", threads: "threads",
};
export function fromZernioPlatform(p: string | null | undefined): Platform | undefined {
  if (!p) return undefined;
  const entry = Object.entries(TO_ZERNIO).find(([, v]) => v === p);
  return entry?.[0] as Platform | undefined;
}

/** Zernio ids are 24-char hex (Mongo ObjectIds); native platform ids are not. */
export const isZernioId = (id: string) => /^[a-f0-9]{24}$/i.test(id);

/**
 * Inbox ids that need an account to be addressed are encoded as `<accountId>:<id>` (Zernio's message and comment
 * endpoints require `accountId`, the provider contract passes one opaque id).
 */
export function joinRef(...parts: string[]): string {
  return parts.join(":");
}
export function splitRef(ref: string, n: 2): [string, string];
export function splitRef(ref: string, n: 3): [string, string, string];
export function splitRef(ref: string, n: number): string[] {
  const parts = ref.split(":");
  if (parts.length < n || parts.some((p) => p.length === 0)) {
    throw new ProviderError(PROVIDER, "invalid_request", `expected an id from this adapter (got "${ref}")`);
  }
  // The last part may itself contain ':' (defensive): re-join the tail.
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(":")];
}

/** Zernio wants a UUID-shaped Idempotency-Key (≤255 chars). Derive a stable one from our key. */
export function idempotencyUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

// --- Accounts -------------------------------------------------------------------------------------------------

export const accountSchema = z.looseObject({
  _id: z.string(),
  platform: z.string(),
  profileId: z.union([z.string(), z.looseObject({ _id: z.string() })]).nullish(),
  username: z.string().nullish(),
  displayName: z.string().nullish(),
  isActive: z.boolean().nullish(),
  needsReconnection: z.boolean().nullish(),
  enabled: z.boolean().nullish(),
});
export const accountsResponse = z.looseObject({ accounts: z.array(accountSchema).default([]) });

export function profileIdOf(a: z.output<typeof accountSchema>): string | undefined {
  const p = a.profileId;
  return typeof p === "string" ? p : p?._id;
}

export function mapAccount(a: z.output<typeof accountSchema>): SocialAccount | undefined {
  const platform = fromZernioPlatform(a.platform);
  if (!platform) return undefined;
  const status: SocialAccount["status"] = a.needsReconnection ? "expired" : a.isActive === false || a.enabled === false ? "error" : "connected";
  return {
    providerAccountId: a._id,
    platform,
    handle: (a.username ?? a.displayName ?? a._id).replace(/^@/, ""),
    ...(a.displayName ? { displayName: a.displayName } : {}),
    status,
  };
}

// --- Posts ----------------------------------------------------------------------------------------------------

const TIKTOK_PRIVACY = { public: "PUBLIC_TO_EVERYONE", friends: "MUTUAL_FOLLOW_FRIENDS", private: "SELF_ONLY" } as const;

function compactObj<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function buildPlatformSpecificData(req: PublishRequest): Record<string, unknown> | undefined {
  const o = req.options ?? {};
  const isVideo = req.media.some((m) => m.kind === "video");
  let data: Record<string, unknown> = {};
  switch (req.platform) {
    case "instagram": {
      const ig = o.instagram ?? {};
      const trial = ig.trialReel === true;
      data = compactObj({
        // A single video becomes a Reel automatically. Trial reels never go to the main grid.
        shareToFeed: isVideo ? (trial ? false : ig.shareToFeed ?? true) : undefined,
        collaborators: ig.collaborators?.length ? ig.collaborators.map((c) => c.replace(/^@/, "")) : undefined,
        // MANUAL unless the owner turned on automatic graduation (Zernio: "MANUAL" | "SS_PERFORMANCE").
        trialParams: trial ? { graduationStrategy: ig.trialGraduation === "SS_PERFORMANCE" ? "SS_PERFORMANCE" : "MANUAL" } : undefined,
        instagramThumbnail: ig.coverUrl,
        firstComment: ig.firstComment,
      });
      break;
    }
    case "youtube": {
      const yt = o.youtube ?? {};
      data = compactObj({ title: yt.title, visibility: yt.privacy ?? "public", madeForKids: yt.madeForKids ?? false });
      break;
    }
    case "facebook":
      data = compactObj({ contentType: isVideo ? "reel" : undefined, pageId: o.facebook?.pageId });
      break;
    case "x":
      data = compactObj({ replySettings: o.x?.replySettings });
      break;
    default:
      data = {};
  }
  return Object.keys(data).length ? data : undefined;
}

/**
 * TikTok settings live at the body root (`tiktokSettings`). `content_preview_confirmed` and `express_consent_given`
 * are TikTok's posting-consent flags: AttentionOS only sets them because a human reviewed the post (approval queue or
 * the autonomy level they chose). Business-app TikTok connections only accept public videos.
 */
export function buildTiktokSettings(req: PublishRequest): Record<string, unknown> | undefined {
  if (req.platform !== "tiktok") return undefined;
  const tt = req.options?.tiktok ?? {};
  const isVideo = req.media.some((m) => m.kind === "video");
  return compactObj({
    privacy_level: TIKTOK_PRIVACY[tt.privacy ?? "public"],
    allow_comment: tt.allowComments ?? true,
    allow_duet: isVideo ? tt.allowDuet ?? true : undefined,
    allow_stitch: isVideo ? tt.allowStitch ?? true : undefined,
    video_made_with_ai: tt.aiGenerated ?? false,
    content_preview_confirmed: true,
    express_consent_given: true,
  });
}

/** POST /v1/posts body. `scheduledFor` is always sent as UTC ISO-8601 with a Z, so `timezone` doesn't matter. */
export function buildCreatePostBody(req: PublishRequest, mediaUrls: { url: string; kind: "video" | "image"; mimeType?: string }[]): Record<string, unknown> {
  const platformSpecificData = buildPlatformSpecificData(req);
  const body: Record<string, unknown> = {
    content: req.caption,
    mediaItems: mediaUrls.map((m) => compactObj({ type: m.kind, url: m.url, mimeType: m.mimeType })),
    platforms: [compactObj({ platform: TO_ZERNIO[req.platform], accountId: req.accountId, platformSpecificData })],
    // Echoed back in webhooks, so events can be matched to our post without a lookup.
    metadata: { attentionosKey: req.idempotencyKey },
  };
  const tiktokSettings = buildTiktokSettings(req);
  if (tiktokSettings) body.tiktokSettings = tiktokSettings;
  if (req.scheduledAt) body.scheduledFor = new Date(req.scheduledAt).toISOString();
  else body.publishNow = true;
  return body;
}

export const platformEntrySchema = z.looseObject({
  platform: z.string().nullish(),
  accountId: z.union([z.string(), z.looseObject({ _id: z.string() })]).nullish(),
  status: z.string().nullish(),
  platformPostId: z.string().nullish(),
  platformPostUrl: z.string().nullish(),
  publishedUrl: z.string().nullish(),
  publishedAt: z.string().nullish(),
  errorMessage: z.string().nullish(),
  errorCategory: z.string().nullish(),
});
export const postSchema = z.looseObject({
  _id: z.string().optional(),
  id: z.string().optional(),
  status: z.string().nullish(),
  scheduledFor: z.string().nullish(),
  publishedAt: z.string().nullish(),
  content: z.string().nullish(),
  platforms: z.array(platformEntrySchema).default([]),
});
export const postEnvelope = z.looseObject({ post: postSchema, message: z.string().optional() });

export type ZernioPublishResult = PublishResult & { error?: string; errorCategory?: string };

export function accountIdOf(e: z.output<typeof platformEntrySchema>): string | undefined {
  const a = e.accountId;
  return typeof a === "string" ? a : a?._id;
}

/** Collapses Zernio's post + per-platform status into one result for the (single) platform we posted to. */
export function mapPost(post: z.output<typeof postSchema>, platform?: Platform): ZernioPublishResult {
  const id = post._id ?? post.id;
  if (!id) throw new ProviderError(PROVIDER, "upstream", "Zernio returned a post without an id");
  const entry = post.platforms.find((p) => !platform || p.platform === TO_ZERNIO[platform]) ?? post.platforms[0];
  const entryStatus = entry?.status ?? undefined;
  let status: PublishResult["status"];
  if (post.status === "failed" || entryStatus === "failed" || post.status === "cancelled") status = "failed";
  else if (post.status === "published" || entryStatus === "published") status = "published";
  else if (post.status === "scheduled" || post.status === "draft") status = "scheduled";
  else status = "publishing"; // publishing, partial (with our entry still pending), processing, uploading
  const url = entry?.platformPostUrl ?? entry?.publishedUrl ?? undefined;
  return compactObj({
    providerPostId: id,
    status,
    url: url ?? undefined,
    platformPostId: entry?.platformPostId ?? undefined,
    scheduledAt: post.scheduledFor ?? undefined,
    error: status === "failed" ? entry?.errorMessage ?? (post.status === "cancelled" ? "cancelled" : undefined) ?? undefined : undefined,
    errorCategory: entry?.errorCategory ?? undefined,
  }) as ZernioPublishResult;
}

// --- Comment-to-DM --------------------------------------------------------------------------------------------

/** lower, Title and UPPER (Zernio doesn't document keyword case-sensitivity; variants make it moot). */
export function keywordVariants(keyword: string): string[] {
  const k = keyword.trim();
  if (!k) throw new ProviderError(PROVIDER, "invalid_request", "an empty keyword would fire on every comment");
  const lower = k.toLowerCase();
  return [...new Set([lower, lower.charAt(0).toUpperCase() + lower.slice(1), lower.toUpperCase(), k])];
}

export const DEFAULT_FOLLOW_GATE = {
  message: "Follow the account first, then tap the button below and I'll send it over.",
  buttonLabel: "I'm following",
  notFollowingMessage: "It looks like you're not following yet. Follow, then tap the button again.",
};

export function buildCommentAutomationBody(req: DmAutomationRequest, profileId: string): Record<string, unknown> {
  if ([...req.dmText].length > 640 && (req.buttons?.length ?? 0) > 0) throw new ProviderError(PROVIDER, "invalid_request", "with buttons, the DM text must be 640 characters or less");
  if ((req.buttons?.length ?? 0) > 3) throw new ProviderError(PROVIDER, "invalid_request", "at most 3 buttons");
  for (const b of req.buttons ?? []) if ([...b.label].length > 20) throw new ProviderError(PROVIDER, "invalid_request", `button label "${b.label}" is over 20 characters`);
  if (req.requireFollow && req.platform !== "instagram") throw new ProviderError(PROVIDER, "invalid_request", "a follow gate only works on Instagram");
  if (req.providerPostId === null) {
    throw new ProviderError(PROVIDER, "invalid_request", "keyword automations must be scoped to one post so the keyword can't fire on other posts");
  }
  const scope = isZernioId(req.providerPostId) ? { postId: req.providerPostId } : { platformPostId: req.providerPostId };
  return compactObj({
    profileId,
    accountId: req.accountId,
    name: `keyword: ${req.keyword}`.slice(0, 100),
    trigger: "comment",
    ...scope,
    keywords: keywordVariants(req.keyword),
    // "contains" (Zernio's default) fires inside other words ("app" fires on "happy"); "word" needs the whole word.
    matchMode: req.matchMode === "exact_word" ? "word" : "contains",
    dmMessage: req.dmText,
    buttons: req.buttons?.length ? req.buttons.map((b) => ({ type: "url", title: b.label, url: b.url })) : undefined,
    commentReply: req.replyComment,
    publicReplyPolicy: req.replyComment ? "after_dm" : undefined,
    repeatPolicy: { mode: "once" },
    ...(req.requireFollow
      ? {
        audience: { followerStatus: "follower", whenUnknown: "verify" },
        followGate: { ...DEFAULT_FOLLOW_GATE, ...(req.followGateText ? { message: req.followGateText } : {}) },
      }
      : {}),
    isActive: true,
  });
}

export const automationSchema = z.looseObject({
  _id: z.string().optional(),
  id: z.string().optional(),
  accountId: z.union([z.string(), z.looseObject({ _id: z.string() })]).nullish(),
  keywords: z.array(z.string()).nullish(),
  platformPostId: z.string().nullish(),
  postId: z.string().nullish(),
  isActive: z.boolean().nullish(),
});

// --- Analytics ------------------------------------------------------------------------------------------------

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
/** Rates may come as 0–1 or 0–100; we store 0–1. */
const rate = (v: unknown): number | undefined => {
  const n = num(v);
  if (n === undefined) return undefined;
  return n > 1 ? n / 100 : n;
};

/** First finite number among the keys. */
const pick = (a: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = num(a[k]);
    if (v !== undefined) return v;
  }
  return undefined;
};

/** A retention curve in any of the shapes platforms return: [{ t|second|time, pct|value|retention }] or a bare array. */
export function mapRetention(v: unknown, durationS?: number): { t: number; pct: number }[] | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const pts: { t: number; pct: number }[] = [];
  v.forEach((p, i) => {
    if (typeof p === "number") {
      pts.push({ t: i, pct: p });
      return;
    }
    if (!p || typeof p !== "object") return;
    const o = p as Record<string, unknown>;
    // YouTube reports elapsedVideoTimeRatio (0–1 of the video) and audienceWatchRatio.
    const ratioT = num(o.elapsedVideoTimeRatio);
    const t = num(o.t) ?? num(o.second) ?? num(o.time) ?? num(o.seconds) ?? (ratioT !== undefined && durationS ? ratioT * durationS : ratioT);
    const pct = num(o.pct) ?? num(o.value) ?? num(o.retention) ?? num(o.audienceWatchRatio);
    if (t !== undefined && pct !== undefined) pts.push({ t, pct });
  });
  if (pts.length < 2) return undefined;
  const scale = pts.some((p) => p.pct > 1.5) ? 1 : 100;
  return pts.map((p) => ({ t: Math.round(p.t * 100) / 100, pct: Math.max(0, Math.min(100, Math.round(p.pct * scale * 10) / 10)) }));
}

/**
 * Zernio's per-platform analytics object → a snapshot. Field names differ by platform and API version
 * (camelCase and snake_case both appear), so every metric reads a short list of known aliases:
 * - watch time: igReelsAvgWatchTime / avgWatchTime (ms), averageTimeWatched (TikTok, s), averageViewDuration (YouTube, s)
 * - skip rate: reelsSkipRate / reels_skip_rate; completion: completionRate / fullVideoWatchedRate / averageViewPercentage
 * - follows: follows / newFollowers / subscribersGained; profile visits: profileViews / profile_views / profileVisits
 * Clicks, impressions, reposts and any retention curve go to `raw.aos` (the shape the CSV import uses too).
 */
export function mapAnalytics(args: {
  platform: Platform;
  platformPostId: string;
  providerPostId?: string;
  url?: string;
  publishedAt?: string;
  caption?: string;
  capturedAt: string;
  analytics: Record<string, unknown>;
}): PostMetricsSnapshot {
  const a = args.analytics;
  const watchMs = pick(a, "igReelsAvgWatchTime", "ig_reels_avg_watch_time", "avgWatchTime", "avg_watch_time");
  const watchS = pick(a, "averageTimeWatched", "averageViewDuration", "average_view_duration", "avgWatchTimeSeconds");
  const durationS = pick(a, "videoDurationSeconds", "video_duration_seconds", "durationSeconds", "duration");
  const aos: Record<string, unknown> = {};
  const clicks = pick(a, "clicks", "websiteClicks", "website_clicks", "linkClicks", "link_clicks");
  const impressions = pick(a, "impressions");
  const reposts = pick(a, "reposts");
  if (clicks !== undefined) aos.clicks = clicks;
  if (impressions !== undefined) aos.impressions = impressions;
  if (reposts !== undefined) aos.reposts = reposts;
  const retention = mapRetention(a.retentionCurve ?? a.retention_curve ?? a.audienceRetention ?? a.retention, durationS);
  if (retention) aos.retention = retention;
  return compactObj({
    platformPostId: args.platformPostId,
    providerPostId: args.providerPostId,
    platform: args.platform,
    capturedAt: args.capturedAt,
    url: args.url,
    publishedAt: args.publishedAt,
    caption: args.caption,
    durationS,
    views: pick(a, "views", "plays", "videoViews", "video_views"),
    reach: pick(a, "reach"),
    likes: pick(a, "likes"),
    comments: pick(a, "comments"),
    shares: pick(a, "shares"),
    saves: pick(a, "saves", "saved"),
    // Instagram returns follows as null on Reels; TikTok/YouTube name it differently.
    follows: pick(a, "follows", "newFollowers", "new_followers", "subscribersGained"),
    profileVisits: pick(a, "profileViews", "profile_views", "profileVisits", "profile_visits"),
    avgWatchTimeS: watchMs !== undefined ? watchMs / 1000 : watchS,
    skipRate: rate(a.reelsSkipRate ?? a.reels_skip_rate),
    completionRate: rate(a.completionRate ?? a.completion_rate ?? a.fullVideoWatchedRate ?? a.averageViewPercentage),
    raw: Object.keys(aos).length ? { ...a, aos } : a,
  }) as PostMetricsSnapshot;
}

/** One day of an account's follower history (from GET /accounts/follower-stats). */
export type ZernioAccountStat = { day: string; platform?: Platform; followers?: number; capturedAt: string };

export function mapFollowerStats(body: unknown, accountId: string, capturedAt: string): ZernioAccountStat[] {
  const b = body as { stats?: Record<string, unknown>; accounts?: { _id?: unknown; platform?: unknown }[] } | null;
  const stats = b?.stats;
  const acct = Array.isArray(b?.accounts) ? b.accounts.find((x) => x?._id === accountId) : undefined;
  const platform = typeof acct?.platform === "string" ? fromZernioPlatform(acct.platform) : undefined;
  const rows = stats && Array.isArray(stats[accountId]) ? (stats[accountId] as unknown[]) : [];
  const out: ZernioAccountStat[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown> | null;
    const day = typeof o?.date === "string" ? o.date.slice(0, 10) : undefined;
    const followers = num(o?.followers);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || followers === undefined) continue;
    out.push({ day, followers, capturedAt, ...(platform ? { platform } : {}) });
  }
  return out.sort((x, y) => x.day.localeCompare(y.day));
}

// --- Errors ---------------------------------------------------------------------------------------------------

/** `{ error, type, code, param, details, platform, platformError }`. Branch on type/code, never on the message. */
export const errorBody = z.looseObject({
  error: z.string().optional(),
  type: z.string().optional(),
  code: z.string().optional(),
  details: z.looseObject({ retryAfterSeconds: z.number().optional(), existingPostId: z.string().optional() }).optional(),
});

const TYPE_TO_CODE: Record<string, ProviderErrorCode> = {
  authentication_error: "auth",
  permission_error: "auth",
  not_found: "not_found",
  rate_limit_error: "rate_limited",
  invalid_request_error: "invalid_request",
  platform_error: "upstream",
  api_error: "upstream",
};

export function describeError(status: number, body: unknown): { code?: ProviderErrorCode; message?: string; vendorCode?: string } {
  const parsed = errorBody.safeParse(body);
  if (!parsed.success) return {};
  const { type, code, error } = parsed.data;
  if (code === "not_thread_owner") {
    return { code: "conflict", vendorCode: code, message: "Another app controls this Instagram conversation (Meta thread control), so Zernio can't reply. Hand the conversation to Zernio or reply from that app." };
  }
  if (code === "message_allowance_exceeded") {
    return { code: "budget_exceeded", vendorCode: code, message: "Zernio's free DM allowance for this month is used up; add a card in Zernio to keep sending." };
  }
  if (code === "insufficient_permissions") {
    return { code: "auth", vendorCode: code, message: "This Zernio API key isn't allowed to do that (restricted key). Create a key with the right access." };
  }
  if (code === "idempotency_conflict") return { code: "conflict", vendorCode: code, message: "The same request is still being processed; try again shortly." };
  return {
    ...(type && TYPE_TO_CODE[type] ? { code: TYPE_TO_CODE[type] } : {}),
    ...(code ? { vendorCode: code } : {}),
    ...(error ? { message: `Zernio: ${error}` } : {}),
  };
}

export function retryAfterFromBody(body: unknown): number | undefined {
  const parsed = errorBody.safeParse(body);
  const s = parsed.success ? parsed.data.details?.retryAfterSeconds : undefined;
  return s !== undefined ? s * 1000 : undefined;
}

import { z } from "zod";
import type { CreatorProfile, ExternalPost } from "@attentionos/core";

/**
 * Dataset item parsers for the default actors. Actor outputs drift over time, so every field is optional
 * and validated loosely; items without an id or URL are dropped rather than failing the whole run.
 */

const num = z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number().finite().nonnegative()).optional().catch(undefined);
const str = z.string().optional().catch(undefined);

const comment = z.object({ text: z.string().default(""), likesCount: num }).passthrough();

/** `apify/instagram-reel-scraper` (also matches `apify/instagram-scraper` post items). */
export const instagramItemSchema = z.object({
  id: str,
  shortCode: str,
  url: str,
  caption: str,
  timestamp: str,
  ownerUsername: str,
  videoPlayCount: num,
  videoViewCount: num,
  likesCount: num,
  commentsCount: num,
  videoDuration: num,
  isPinned: z.boolean().optional().catch(undefined),
  videoUrl: str,
  displayUrl: str,
  latestComments: z.array(comment).optional().catch(undefined),
}).passthrough();

export function parseInstagramItem(raw: unknown, handle: string): ExternalPost | null {
  const r = instagramItemSchema.safeParse(raw);
  if (!r.success) return null;
  const it = r.data;
  const id = it.shortCode ?? it.id;
  const url = it.url ?? (it.shortCode ? `https://www.instagram.com/reel/${it.shortCode}/` : undefined);
  if (!id || !url || !it.timestamp) return null;
  // Likes of -1 mean "hidden by the creator" on Instagram; treat as unknown.
  const likes = it.likesCount !== undefined && it.likesCount >= 0 ? it.likesCount : undefined;
  return clean({
    platform: "instagram",
    platformPostId: id,
    authorHandle: (it.ownerUsername ?? handle).replace(/^@/, ""),
    url,
    publishedAt: new Date(it.timestamp).toISOString(),
    caption: it.caption,
    durationS: it.videoDuration,
    isPinned: it.isPinned ?? false,
    views: it.videoPlayCount ?? it.videoViewCount,
    likes,
    comments: it.commentsCount,
    topComments: topComments(it.latestComments?.map((c) => ({ text: c.text, likes: c.likesCount }))),
    videoUrl: it.videoUrl,
    thumbnailUrl: it.displayUrl,
  });
}

/** `clockworks/tiktok-scraper`. */
export const tiktokItemSchema = z.object({
  id: str,
  text: str,
  createTimeISO: str,
  createTime: num,
  webVideoUrl: str,
  playCount: num,
  diggCount: num,
  commentCount: num,
  shareCount: num,
  isPinned: z.boolean().optional().catch(undefined),
  authorMeta: z.object({ name: str, fans: num, following: num, video: num }).passthrough().optional().catch(undefined),
  videoMeta: z.object({ duration: num, coverUrl: str, downloadAddr: str }).passthrough().optional().catch(undefined),
  mediaUrls: z.array(z.string()).optional().catch(undefined),
}).passthrough();

export function parseTiktokItem(raw: unknown, handle: string): ExternalPost | null {
  const r = tiktokItemSchema.safeParse(raw);
  if (!r.success) return null;
  const it = r.data;
  const published = it.createTimeISO ?? (it.createTime ? new Date(it.createTime * 1000).toISOString() : undefined);
  const author = (it.authorMeta?.name ?? handle).replace(/^@/, "");
  const url = it.webVideoUrl ?? (it.id ? `https://www.tiktok.com/@${author}/video/${it.id}` : undefined);
  if (!it.id || !url || !published) return null;
  return clean({
    platform: "tiktok",
    platformPostId: it.id,
    authorHandle: author,
    url,
    publishedAt: new Date(published).toISOString(),
    caption: it.text,
    durationS: it.videoMeta?.duration,
    isPinned: it.isPinned ?? false,
    views: it.playCount,
    likes: it.diggCount,
    comments: it.commentCount,
    shares: it.shareCount,
    videoUrl: it.mediaUrls?.[0] ?? it.videoMeta?.downloadAddr,
    thumbnailUrl: it.videoMeta?.coverUrl,
  });
}

/** `streamers/youtube-scraper`. Duration comes as "m:ss" or "h:mm:ss". */
export const youtubeItemSchema = z.object({
  id: str,
  title: str,
  text: str,
  url: str,
  date: str,
  viewCount: num,
  likes: num,
  commentsCount: num,
  duration: str,
  thumbnailUrl: str,
  channelUsername: str,
  numberOfSubscribers: num,
  channelTotalVideos: num,
  aboutChannelInfo: z.object({ numberOfSubscribers: num, channelTotalVideos: num }).passthrough().optional().catch(undefined),
}).passthrough();

export function parseDuration(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const parts = d.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function parseYoutubeItem(raw: unknown, handle: string): ExternalPost | null {
  const r = youtubeItemSchema.safeParse(raw);
  if (!r.success) return null;
  const it = r.data;
  if (!it.id || !it.url || !it.date) return null;
  return clean({
    platform: "youtube",
    platformPostId: it.id,
    authorHandle: (it.channelUsername ?? handle).replace(/^@/, ""),
    url: it.url,
    publishedAt: new Date(it.date).toISOString(),
    caption: [it.title, it.text].filter(Boolean).join("\n\n") || undefined,
    durationS: parseDuration(it.duration),
    views: it.viewCount,
    likes: it.likes,
    comments: it.commentsCount,
    thumbnailUrl: it.thumbnailUrl,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Account numbers (followers / following / posts)
// ---------------------------------------------------------------------------------------------------------------

/** `apify/instagram-profile-scraper` details item. */
export const instagramProfileSchema = z.object({ username: str, followersCount: num, followsCount: num, postsCount: num }).passthrough();

type Counts = Omit<CreatorProfile, "platform" | "handle" | "capturedAt">;

function profile(platform: CreatorProfile["platform"], handle: string, c: Counts, capturedAt: string): CreatorProfile | null {
  if (c.followers === undefined) return null;
  const counts = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Counts;
  return { platform, handle: handle.replace(/^@/, ""), ...counts, capturedAt };
}

export function parseInstagramProfile(raw: unknown, handle: string, capturedAt = new Date().toISOString()): CreatorProfile | null {
  const r = instagramProfileSchema.safeParse(raw);
  if (!r.success) return null;
  const it = r.data;
  return profile("instagram", it.username ?? handle, { followers: it.followersCount, following: it.followsCount, posts: it.postsCount }, capturedAt);
}

/** TikTok post items carry the author's counts in `authorMeta`. */
export function parseTiktokProfile(raw: unknown, handle: string, capturedAt = new Date().toISOString()): CreatorProfile | null {
  const r = tiktokItemSchema.safeParse(raw);
  if (!r.success || !r.data.authorMeta) return null;
  const a = r.data.authorMeta;
  return profile("tiktok", a.name ?? handle, { followers: a.fans, following: a.following, posts: a.video }, capturedAt);
}

/** YouTube video items carry the channel's subscriber count (top level or under `aboutChannelInfo`). */
export function parseYoutubeProfile(raw: unknown, handle: string, capturedAt = new Date().toISOString()): CreatorProfile | null {
  const r = youtubeItemSchema.safeParse(raw);
  if (!r.success) return null;
  const it = r.data;
  return profile("youtube", it.channelUsername ?? handle, {
    followers: it.numberOfSubscribers ?? it.aboutChannelInfo?.numberOfSubscribers,
    posts: it.channelTotalVideos ?? it.aboutChannelInfo?.channelTotalVideos,
  }, capturedAt);
}

function topComments(list: { text: string; likes?: number }[] | undefined, max = 10) {
  if (!list?.length) return undefined;
  return [...list].filter((c) => c.text.trim()).sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, max);
}

function clean(post: ExternalPost): ExternalPost {
  return Object.fromEntries(Object.entries(post).filter(([, v]) => v !== undefined)) as ExternalPost;
}

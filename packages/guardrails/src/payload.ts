import type { MediaRef, Platform, PublisherCapabilities, PublishRequest, SocialAccount } from "@attentionos/core";
import { CAPTION_LIMITS, xLength, YOUTUBE_TITLE_MAX } from "./captions.ts";
import { IssueCollector, type ValidationResult } from "./issues.ts";

/**
 * Publish payload validation: every payload is checked against the accounts snapshot,
 * the publisher's capabilities and per-platform rules BEFORE any API call. Nothing here does I/O
 * unless you pass `mediaBytes`.
 */

export type PayloadOptions = {
  /** Injectable clock. */
  now?: Date;
  /** A scheduled time must be at least this far in the future. Default 2 minutes. */
  minLeadMs?: number;
  /** config.acknowledgements; trial reels need `trialReelsRisk`. */
  acknowledgements?: { trialReelsRisk?: boolean };
  /** Size lookup for local media (e.g. fs.statSync). Used with capabilities.maxVideoBytes. */
  mediaBytes?: (media: MediaRef) => number | undefined;
};

type MediaRule = {
  video: "required" | "optional" | "none";
  maxImages: number;
  minVideoS?: number;
  maxVideoS?: number;
  mixed: boolean;
};

/** Conservative per-platform media rules for short-form posts. */
export const MEDIA_RULES: Record<Platform, MediaRule> = {
  instagram: { video: "optional", maxImages: 10, minVideoS: 3, maxVideoS: 900, mixed: true },
  tiktok: { video: "optional", maxImages: 35, minVideoS: 3, maxVideoS: 600, mixed: false },
  youtube: { video: "required", maxImages: 0, minVideoS: 1, maxVideoS: 180, mixed: false },
  facebook: { video: "optional", maxImages: 10, minVideoS: 1, maxVideoS: 90, mixed: false },
  linkedin: { video: "optional", maxImages: 9, minVideoS: 3, maxVideoS: 600, mixed: false },
  x: { video: "optional", maxImages: 4, minVideoS: 0.5, maxVideoS: 140, mixed: false },
  threads: { video: "optional", maxImages: 10, minVideoS: 1, maxVideoS: 300, mixed: true },
};

const MEDIA_REQUIRED: ReadonlySet<Platform> = new Set(["instagram", "tiktok", "youtube"]);
const VIDEO_MIME = /^video\/(mp4|quicktime)$/;
const IMAGE_MIME = /^image\/(jpeg|png|webp)$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

export function validatePublishPayload(
  req: PublishRequest,
  accountsSnapshot: readonly SocialAccount[],
  capabilities: PublisherCapabilities,
  opts: PayloadOptions = {},
): ValidationResult {
  const c = new IssueCollector();
  const p = req.platform;

  // Idempotency
  if (!req.idempotencyKey || !req.idempotencyKey.trim()) {
    c.error("payload.idempotency_missing", "The payload has no idempotency key, so a retry could post twice.", { path: "idempotencyKey", fix: "Set a stable key per post and platform, e.g. <content id>:<platform>:<version>." });
  } else if (!IDEMPOTENCY_KEY_RE.test(req.idempotencyKey)) {
    c.error("payload.idempotency_format", `Idempotency key "${req.idempotencyKey.slice(0, 40)}" must be 8 to 200 characters of letters, digits, dot, dash, underscore or colon.`, { path: "idempotencyKey", fix: "Build it from ids, e.g. <content id>:<platform>:<version>." });
  }

  // Account
  const account = accountsSnapshot.find((a) => a.providerAccountId === req.accountId);
  if (!account) {
    c.error("payload.account_missing", `Account "${req.accountId}" isn't in the connected accounts.`, { path: "accountId", fix: "Refresh the accounts list and pick a connected account for this platform." });
  } else {
    if (account.status !== "connected") {
      c.error("payload.account_not_connected", `The ${p} account ${account.handle} is ${account.status}.`, { path: "accountId", fix: "Reconnect it in the publishing provider, then refresh the accounts list." });
    }
    if (account.platform !== p) {
      c.error("payload.platform_mismatch", `Account ${account.handle} is a ${account.platform} account, but the payload is for ${p}.`, { path: "platform", fix: `Use the ${p} account, or change the payload platform to ${account.platform}.` });
    }
  }
  if (!capabilities.platforms.includes(p)) {
    c.error("payload.platform_unsupported", `The publishing provider can't post to ${p}.`, { path: "platform", fix: "Post there manually or switch providers." });
  }

  // Caption
  const caption = req.caption ?? "";
  const limit = CAPTION_LIMITS[p];
  const len = p === "x" ? xLength(caption) : [...caption].length;
  if (len > limit) {
    c.error("payload.caption_too_long", `The ${p} caption is ${len} characters; the limit is ${limit}.`, { path: "caption", fix: `Cut ${len - limit} characters.` });
  }
  if (!caption.trim() && (req.media ?? []).length === 0) {
    c.error("payload.empty", "The payload has no caption and no media.", { path: "caption", fix: "Add the caption, the media, or both." });
  }

  // Per-platform required fields
  const o = req.options ?? {};
  if (p === "youtube") {
    const title = o.youtube?.title ?? "";
    if (!title.trim()) c.error("payload.youtube_title_missing", "YouTube needs a title.", { path: "options.youtube.title", fix: "Use the title from the captions package." });
    else if (title.length >= YOUTUBE_TITLE_MAX) c.error("payload.youtube_title_length", `The YouTube title is ${title.length} characters; it must be under ${YOUTUBE_TITLE_MAX}.`, { path: "options.youtube.title", fix: `Cut ${title.length - YOUTUBE_TITLE_MAX + 1} characters.` });
    if (o.youtube?.madeForKids === undefined) c.warn("payload.youtube_made_for_kids", "madeForKids isn't set; YouTube requires an answer.", { path: "options.youtube.madeForKids", fix: "Set madeForKids to false unless the video is made for children." });
  }
  if (p === "tiktok") {
    if (!o.tiktok?.privacy) c.error("payload.tiktok_privacy_missing", "TikTok needs a privacy setting.", { path: "options.tiktok.privacy", fix: 'Set options.tiktok.privacy to "public", "friends" or "private".' });
    if (o.tiktok?.aiGenerated === undefined) c.warn("payload.tiktok_ai_label", "The TikTok AI-generated label isn't set.", { path: "options.tiktok.aiGenerated", fix: "Set aiGenerated to true when the video uses AI-generated visuals or voice, false otherwise." });
  }
  for (const key of Object.keys(o)) {
    if (key !== p) c.warn("payload.foreign_options", `options.${key} is set on a ${p} payload and will be ignored.`, { path: `options.${key}`, fix: "Remove it." });
  }

  // Media
  const media = req.media ?? [];
  const rule = MEDIA_RULES[p];
  if (MEDIA_REQUIRED.has(p) && media.length === 0) {
    c.error("payload.media_missing", `${p} posts need media, and this payload has none.`, { path: "media", fix: "Attach the rendered video." });
  }
  const videos = media.filter((m) => m.kind === "video");
  const images = media.filter((m) => m.kind === "image");
  if (rule.video === "required" && media.length > 0 && videos.length === 0) c.error("payload.video_required", `${p} needs a video.`, { path: "media", fix: "Attach the rendered video." });
  if (videos.length > 1) c.error("payload.too_many_videos", `${videos.length} videos in one ${p} post; use one.`, { path: "media", fix: "Keep one video per post." });
  if (images.length > rule.maxImages) c.error("payload.too_many_images", `${images.length} images; ${p} allows ${rule.maxImages}.`, { path: "media", fix: `Keep ${rule.maxImages} or fewer.` });
  if (!rule.mixed && videos.length > 0 && images.length > 0) c.error("payload.mixed_media", `${p} can't mix video and images in one post.`, { path: "media", fix: "Post the video alone, or the images alone." });
  media.forEach((m, i) => {
    const path = `media[${i}]`;
    if (!m.url && !m.localPath) c.error("payload.media_no_source", `Media ${i + 1} has neither a url nor a local path.`, { path, fix: "Upload it first and set the url, or set localPath." });
    if (m.url && !/^https:\/\//i.test(m.url)) c.error("payload.media_url", `Media ${i + 1} url must be https.`, { path: `${path}.url`, fix: "Use the provider's uploaded https url." });
    if (m.mimeType) {
      const okMime = m.kind === "video" ? VIDEO_MIME.test(m.mimeType) : IMAGE_MIME.test(m.mimeType);
      if (!okMime) c.error("payload.media_type", `Media ${i + 1} is ${m.mimeType}, which isn't an accepted ${m.kind} format.`, { path: `${path}.mimeType`, fix: m.kind === "video" ? "Export H.264 MP4." : "Use JPEG, PNG or WebP." });
    }
    if (m.kind === "video" && m.durationS !== undefined) {
      if (rule.minVideoS !== undefined && m.durationS < rule.minVideoS) c.error("payload.video_too_short", `The video is ${m.durationS}s; ${p} needs at least ${rule.minVideoS}s.`, { path: `${path}.durationS` });
      const maxS = p === "youtube" && o.youtube?.shorts === false ? 43200 : rule.maxVideoS;
      if (maxS !== undefined && m.durationS > maxS) c.error("payload.video_too_long", `The video is ${m.durationS}s; ${p}${p === "youtube" ? " Shorts" : ""} allows up to ${maxS}s.`, { path: `${path}.durationS`, fix: "Trim it or post the full version as a long-form video." });
    }
    if (m.kind === "video" && capabilities.maxVideoBytes && opts.mediaBytes) {
      const bytes = opts.mediaBytes(m);
      if (bytes !== undefined && bytes > capabilities.maxVideoBytes) {
        c.error("payload.video_too_big", `The video is ${(bytes / 1e6).toFixed(1)} MB; the provider accepts up to ${(capabilities.maxVideoBytes / 1e6).toFixed(1)} MB.`, { path, fix: "Re-export at a lower bitrate." });
      }
    }
  });

  // Schedule
  if (req.scheduledAt !== undefined) {
    if (!capabilities.scheduling) c.error("payload.scheduling_unsupported", "The provider can't schedule posts.", { path: "scheduledAt", fix: "Publish at the slot time from the worker instead." });
    if (!ISO_WITH_ZONE.test(req.scheduledAt) || Number.isNaN(Date.parse(req.scheduledAt))) {
      c.error("payload.schedule_format", `scheduledAt "${req.scheduledAt}" must be an ISO time with a timezone (e.g. 2026-10-20T14:00:00Z).`, { path: "scheduledAt", fix: "Convert the slot to UTC and include the Z." });
    } else {
      const now = (opts.now ?? new Date()).getTime();
      const lead = opts.minLeadMs ?? 2 * 60_000;
      const at = Date.parse(req.scheduledAt);
      if (at < now + lead) {
        c.error("payload.schedule_past", `scheduledAt ${req.scheduledAt} is ${at < now ? "in the past" : "too soon"}; it must be at least ${Math.round(lead / 60_000)} minutes from now.`, { path: "scheduledAt", fix: "Pick the next open slot, or publish now by leaving scheduledAt out." });
      }
    }
  }

  // Instagram extras
  const ig = o.instagram;
  if (ig?.trialReel) {
    if (p !== "instagram") c.error("payload.trial_reel_platform", "Trial reels exist only on Instagram.", { path: "options.instagram.trialReel" });
    if (!capabilities.instagramTrialReels) c.error("payload.trial_reel_unsupported", "The provider doesn't support trial reels.", { path: "options.instagram.trialReel", fix: "Turn trial reels off for this provider." });
    if (opts.acknowledgements?.trialReelsRisk !== true) c.error("payload.trial_reel_not_acknowledged", "Trial reels are on but the platform-risk notice hasn't been acknowledged.", { path: "options.instagram.trialReel", fix: "Acknowledge the trial reels notice in setup (acknowledgements.trialReelsRisk) or turn trial reels off." });
    if (videos.length === 0) c.error("payload.trial_reel_media", "A trial reel needs a video.", { path: "media" });
  }
  if (ig?.trialGraduation && !ig.trialReel) {
    c.error("payload.trial_graduation_without_trial", "A graduation setting only applies to trial reels.", { path: "options.instagram.trialGraduation" });
  }
  if (ig?.collaborators && ig.collaborators.length > 0 && !capabilities.instagramCollaborators) {
    c.error("payload.collaborators_unsupported", "The provider can't add Instagram collaborators.", { path: "options.instagram.collaborators", fix: "Remove them, or add collaborators by hand after posting." });
  }
  if (ig?.firstComment && !capabilities.firstComment) {
    c.error("payload.first_comment_unsupported", "The provider can't post a first comment.", { path: "options.instagram.firstComment", fix: "Remove it and post the comment by hand." });
  }
  return c.result();
}

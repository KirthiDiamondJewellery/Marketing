import { z } from "zod";
import { compact, PLATFORMS, ToolError, defineTool, type WorkspaceContext } from "@attentionos/core";
import { buildTrackedUrl, buildUtm, buildUtmContent } from "../lib/links.ts";
import { getPost, loadContent, ensurePostNumber, updatePost, advanceContent, type PostRow } from "../lib/repo.ts";
import { cancelPost, crossPost, schedulePost, scheduleWeek, type ScheduleOutcome } from "../lib/scheduler.ts";
import { trackingFor, linkDestination } from "../lib/tracking.ts";
import { confirmTrialProof } from "../lib/trial-flow.ts";
import { activity } from "../lib/gate.ts";
import { publishingSettings } from "../settings.ts";

const platform = z.enum(PLATFORMS);
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d{2}:\d{2})$/.test(s), "use ISO-8601 with a timezone, e.g. 2026-10-20T14:00:00Z");

function outcomeView(o: ScheduleOutcome) {
  return compact({
    outcome: o.outcome,
    message: o.message,
    postId: o.postId,
    approvalRef: o.approvalRef,
    errors: o.check.errors.length ? o.check.errors : undefined,
    warnings: o.check.warnings.length ? o.check.warnings : undefined,
    preview: o.preview,
  });
}

function postView(ws: WorkspaceContext, p: PostRow) {
  return compact({
    id: p.id,
    title: p.payload?.title,
    platform: p.platform,
    status: p.status,
    scheduledAt: p.scheduled_at ? new Date(p.scheduled_at).toISOString() : undefined,
    publishedAt: p.published_at ? new Date(p.published_at).toISOString() : undefined,
    mode: p.payload?.mode,
    url: p.url,
    utmContent: p.utm_content,
    shortLink: p.short_link,
    trial: p.is_trial || undefined,
    error: p.error,
    contentId: p.content_id,
    provider: p.provider !== ws.config.providers.publisher ? p.provider : undefined,
  });
}

export const planWeekTool = defineTool({
  name: "publishing_plan_week",
  description:
    "Plan a week of posts from the cadence (slots per platform) and the finished pieces. Always a dry run first: it returns the plan table and sends nothing. Call again with confirm=true to schedule it; posts then wait for the user's approval (one approval for the week) before anything goes to the publisher. Instagram main-feed posts are 'assist' by default: the user gets the file and caption to post themselves.",
  input: z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Any date in the week (local). Default: next week."),
    confirm: z.boolean().default(false).describe("false = dry run (default). true = create the posts and ask for approval."),
  }),
  async handler({ ws }, input) {
    const res = await scheduleWeek(ws, { ...(input.weekStart ? { weekStart: input.weekStart } : {}), dryRun: !input.confirm });
    return compact({
      message: res.message,
      dryRun: res.dryRun,
      approvalRef: res.approvalRef,
      plan: res.table,
      entries: res.manifest.entries.map((e) => ({ contentId: e.contentId, title: e.title, platform: e.platform, local: `${e.localDate} ${e.localTime}`, scheduledAt: e.scheduledAt, mode: e.mode })),
      openSlots: res.manifest.openSlots.length ? res.manifest.openSlots : undefined,
      unplaced: res.manifest.unplaced.length ? res.manifest.unplaced : undefined,
      skippedPlatforms: res.manifest.skippedPlatforms.length ? res.manifest.skippedPlatforms : undefined,
      problems: res.outcomes.filter((o) => o.outcome === "invalid" || o.outcome === "failed").map((o) => ({ contentId: o.contentId, platform: o.platform, message: o.message })),
    });
  },
});

export const validatePayloadTool = defineTool({
  name: "publishing_validate_payload",
  description:
    "Check a post before scheduling it: builds the exact payload (caption, media, account, options, tracked link) and runs every gate against the connected accounts and the publisher's capabilities. Never calls the publisher. Use it to fix captions before asking for approval.",
  annotations: { readOnly: true },
  input: z.object({
    contentId: z.string().uuid(),
    platform,
    scheduledAt: iso.optional(),
    caption: z.string().max(70_000).optional().describe("Override the caption from the captions package."),
  }),
  async handler({ ws }, input) {
    const o = await schedulePost(ws, {
      contentId: input.contentId, platform: input.platform, dryRun: true,
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.caption !== undefined ? { captionOverride: input.caption } : {}),
    });
    return outcomeView(o);
  },
});

export const schedulePostTool = defineTool({
  name: "publishing_schedule_post",
  description:
    "Schedule one piece on one platform. dryRun=true (default) only validates and previews. With dryRun=false the post is saved with an idempotency key (it can never be posted twice) and, depending on the Publisher's autonomy level, waits for the user's approval (returns an ap-N ref) or goes to the publisher. Instagram main feed defaults to assist (the user posts it). Call again after approval to send it, or let publishing.publish-due do it.",
  input: z.object({
    contentId: z.string().uuid(),
    platform,
    scheduledAt: iso.optional().describe("Omit to publish as soon as it's approved."),
    caption: z.string().max(70_000).optional(),
    dryRun: z.boolean().default(true),
    campaign: z.boolean().optional().describe("Mark as a campaign/offer post (always waits for approval under review_key)."),
    mode: z.enum(["auto", "assist"]).optional().describe("Override assist/auto for this post."),
  }),
  annotations: { openWorld: true },
  async handler({ ws }, input) {
    const o = await schedulePost(ws, {
      contentId: input.contentId, platform: input.platform, dryRun: input.dryRun,
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.caption !== undefined ? { captionOverride: input.caption } : {}),
      ...(input.campaign !== undefined ? { isKey: input.campaign } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
    return outcomeView(o);
  },
});

export const listScheduledTool = defineTool({
  name: "publishing_list_scheduled",
  description: "List posts: upcoming by default, or filter by status, platform or date range. Shows approval waits, assist posts and failures with plain reasons.",
  annotations: { readOnly: true },
  input: z.object({
    status: z.enum(["upcoming", "draft", "queued", "scheduled", "publishing", "published", "failed", "cancelled", "assist", "all"]).default("upcoming"),
    platform: platform.optional(),
    from: iso.optional(),
    to: iso.optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  async handler({ ws }, input) {
    const upcoming = ["draft", "queued", "scheduled", "publishing", "assist"];
    const statuses = input.status === "upcoming" ? upcoming : input.status === "all" ? null : [input.status];
    const rows = await ws.sql<PostRow[]>`
      select * from posts
       where workspace_id = ${ws.id}
         ${statuses ? ws.sql`and status = any(${statuses})` : ws.sql``}
         ${input.platform ? ws.sql`and platform = ${input.platform}` : ws.sql``}
         ${input.from ? ws.sql`and scheduled_at >= ${new Date(input.from)}` : ws.sql``}
         ${input.to ? ws.sql`and scheduled_at <= ${new Date(input.to)}` : ws.sql``}
       order by ${input.status === "published" ? ws.sql`published_at desc nulls last` : ws.sql`scheduled_at asc nulls first`}
       limit ${input.limit}`;
    return { posts: rows.map((r) => postView(ws, r)) };
  },
});

export const cancelPostTool = defineTool({
  name: "publishing_cancel_post",
  description: "Cancel a post that isn't live yet (also removes it from the publisher's schedule and withdraws its pending approval). Live posts must be deleted on the platform.",
  annotations: { destructive: true, openWorld: true },
  input: z.object({ postId: z.string().uuid() }),
  async handler({ ws }, input) {
    const res = await cancelPost(ws, input.postId);
    if (!res.ok) throw new ToolError(res.message);
    return res;
  },
});

export const buildTrackedLinkTool = defineTool({
  name: "publishing_build_tracked_link",
  description:
    "Build the tracked link for a post: utm_content=<prefix><keyword>_<post#> (the post number comes from the piece, assigned once) and utm_source=<platform>, pointing at the piece's lead magnet or your site. With shortLink=true and short links turned on, also creates a short link on your own site.",
  input: z.object({
    contentId: z.string().uuid().optional(),
    keyword: z.string().regex(/^[A-Za-z]{2,30}$/).optional().describe("Only when there is no content id."),
    postNumber: z.number().int().positive().optional().describe("Only when there is no content id."),
    platform: z.string().min(1).max(30).default("instagram").describe("Becomes utm_source (a platform, or e.g. 'bio', 'story', 'dm')."),
    destination: z.string().url().optional(),
    shortLink: z.boolean().default(false),
  }),
  async handler({ ws }, input) {
    if (input.contentId) {
      const content = await loadContent(ws, input.contentId);
      if (!content) throw new ToolError("That piece of content doesn't exist.");
      const postNumber = content.postNumber ?? (await ensurePostNumber(ws, content.id));
      const t = await trackingFor(ws, {
        platform: input.platform, keyword: content.keyword, postNumber, leadMagnetUrl: input.destination ?? content.leadMagnetUrl,
        label: `${content.title} (${input.platform})`, createShort: input.shortLink,
      });
      return compact({ ...t, postNumber });
    }
    if (!input.postNumber) throw new ToolError("Give a contentId, or a keyword and post number.");
    const s = publishingSettings(ws.config);
    let prefix = "";
    try { prefix = ws.brand().brand.cta.utmContentPrefix; } catch { /* no brand kit yet */ }
    const utmContent = buildUtmContent({ prefix, keyword: input.keyword ?? null, postNumber: input.postNumber });
    const destination = input.destination ?? linkDestination(ws, null);
    if (!destination) return { utmContent, note: "No destination: pass one or set brand.cta.siteUrl." };
    const utm = buildUtm({ platform: input.platform, medium: s.tracking.utmMedium, campaign: s.tracking.utmCampaign, content: utmContent });
    return { utmContent, utm, trackedUrl: buildTrackedUrl(destination, utm) };
  },
});

export const crossPostTool = defineTool({
  name: "publishing_cross_post",
  description:
    "Queue a reel that's already on Instagram to the other platforms (or backfill the newest N). Comment-keyword CTAs are swapped for a tracked link line, or 'link in bio' where caption links aren't clickable. Uses the next open cadence slot per platform. Dry run by default; each post then follows the normal approval rules.",
  input: z.object({
    postId: z.string().uuid().optional().describe("The Instagram post to copy."),
    contentId: z.string().uuid().optional(),
    backfill: z.number().int().min(1).max(50).optional().describe("Copy the newest N Instagram posts that weren't cross-posted yet."),
    platforms: z.array(platform).optional(),
    scheduledAt: iso.optional(),
    dryRun: z.boolean().default(true),
  }),
  annotations: { openWorld: true },
  async handler({ ws }, input) {
    const res = await crossPost(ws, {
      dryRun: input.dryRun,
      ...(input.postId ? { sourcePostId: input.postId } : {}),
      ...(input.contentId ? { contentId: input.contentId } : {}),
      ...(input.backfill ? { backfill: input.backfill } : {}),
      ...(input.platforms ? { platforms: input.platforms } : {}),
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
    });
    return { message: res.message, posts: res.outcomes.map((o) => ({ platform: o.platform, contentId: o.contentId, ...outcomeView(o) })) };
  },
});

export const markPostedTool = defineTool({
  name: "publishing_mark_posted",
  description: "For assist posts the user published by hand: record the live link so results and leads are tracked against it.",
  input: z.object({ postId: z.string().uuid(), url: z.string().url(), platformPostId: z.string().max(100).optional() }),
  async handler({ ws, actor }, input) {
    const post = await getPost(ws, input.postId);
    if (!post) throw new ToolError("No post with that id.");
    if (post.status === "published") return { message: "Already marked as live.", url: post.url };
    if (post.status !== "assist") throw new ToolError(`That post is ${post.status}, not waiting to be posted by hand.`);
    await updatePost(ws, post.id, { status: "published", url: input.url, published_at: ws.now(), ...(input.platformPostId ? { platform_post_id: input.platformPostId } : {}) });
    await advanceContent(ws, post.content_id, "published", ws.now());
    await activity(ws, actor, `"${post.payload?.title ?? "A post"}" is live on ${post.platform}`, { postId: post.id, url: input.url });
    return { message: "Marked as live. Results will be tracked against this post.", postId: post.id };
  },
});

export const confirmTrialProofTool = defineTool({
  name: "publishing_confirm_trial_proof",
  description: "Trial reels only: after the first live trial reel, the USER confirms it stayed off the main grid (Instagram shows it as not shared to feed). This unlocks full trial-reel batches on that account. Agents can't confirm it.",
  input: z.object({ postId: z.string().uuid() }),
  async handler({ ws, actor }, input) {
    const res = await confirmTrialProof(ws, input.postId, actor);
    if (!res.ok) throw new ToolError(res.message);
    return res;
  },
});

export const tools = [
  planWeekTool, validatePayloadTool, schedulePostTool, listScheduledTool, cancelPostTool, buildTrackedLinkTool, crossPostTool, markPostedTool, confirmTrialProofTool,
];

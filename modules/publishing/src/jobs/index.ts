import { z } from "zod";
import { PLATFORMS, defineNativeJob } from "@attentionos/core";
import { notify } from "../lib/gate.ts";
import { syncAccounts } from "../lib/repo.ts";
import { applyPublishEvent, crossPost, publishDue, scheduleWeek } from "../lib/scheduler.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export const scheduleWeekJob = defineNativeJob({
  id: "publishing.schedule-week",
  kind: "native",
  agent: "publisher",
  description: "Plans next week's posts per platform from the cadence. Dry run by default; with dryRun false it schedules the plan after approval.",
  input: z.object({ weekStart: isoDate.optional(), dryRun: z.boolean().default(true) }),
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const res = await scheduleWeek(ctx.ws, { ...(ctx.input.weekStart ? { weekStart: ctx.input.weekStart } : {}), dryRun: ctx.input.dryRun, runId: ctx.runId });
    await ctx.progress(res.message);
    if (ctx.input.dryRun && res.manifest.entries.length > 0) {
      await notify(ctx.ws, {
        dedupeKey: `week-plan:${res.manifest.weekStart}`,
        text: `${res.message}\n\n${res.table}\n\nSay "schedule the week" to send it for approval.`,
        format: "plain",
      });
    }
    return { message: res.message, weekStart: res.manifest.weekStart, entries: res.manifest.entries.length, openSlots: res.manifest.openSlots.length, approvalRef: res.approvalRef };
  },
});

export const publishDueJob = defineNativeJob({
  id: "publishing.publish-due",
  kind: "native",
  agent: "publisher",
  description: "Sends approved posts to the publisher, sends Instagram assist reminders and checks posts in flight. Safe to run any time.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(25) }),
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const s = await publishDue(ctx.ws, { limit: ctx.input.limit, runId: ctx.runId });
    const parts = [
      s.sent && `sent ${s.sent}`, s.approved && `${s.approved} newly approved`, s.assistNotified && `${s.assistNotified} reminder${s.assistNotified === 1 ? "" : "s"} to post`,
      s.refreshed && `checked ${s.refreshed} in flight`, s.failed && `${s.failed} failed`, s.waiting && `${s.waiting} waiting for approval`,
    ].filter(Boolean);
    if (parts.length) await ctx.progress(`Posts: ${parts.join(", ")}`);
    return s;
  },
});

export const crossPostJob = defineNativeJob({
  id: "publishing.cross-post",
  kind: "native",
  agent: "publisher",
  description: "Queues reels already on Instagram to the other platforms, swapping comment-keyword CTAs for a link line.",
  input: z.object({
    sourcePostId: z.string().uuid().optional(),
    contentId: z.string().uuid().optional(),
    backfill: z.number().int().min(1).max(50).optional(),
    platforms: z.array(z.enum(PLATFORMS)).optional(),
    scheduledAt: z.string().optional(),
    dryRun: z.boolean().default(true),
  }),
  timeoutMs: 15 * 60_000,
  async run(ctx) {
    const res = await crossPost(ctx.ws, { ...ctx.input, runId: ctx.runId });
    await ctx.progress(res.message);
    return { message: res.message, outcomes: res.outcomes.map((o) => ({ contentId: o.contentId, platform: o.platform, outcome: o.outcome, postId: o.postId, message: o.message })) };
  },
});

export const syncAccountsJob = defineNativeJob({
  id: "publishing.sync-accounts",
  kind: "native",
  agent: "publisher",
  description: "Refreshes the list of connected social accounts from the publisher.",
  input: z.object({}),
  async run(ctx) {
    const accounts = await syncAccounts(ctx.ws);
    const broken = accounts.filter((a) => a.status !== "connected");
    if (broken.length) {
      await notify(ctx.ws, {
        dedupeKey: `accounts-broken:${ctx.ws.now().toISOString().slice(0, 10)}`,
        text: `These accounts need reconnecting in ${ctx.ws.config.providers.publisher}: ${broken.map((a) => `${a.platform} @${a.handle}`).join(", ")}`,
        priority: "high",
      });
    }
    await ctx.progress(`${accounts.length} connected account${accounts.length === 1 ? "" : "s"}${broken.length ? `, ${broken.length} need reconnecting` : ""}`);
    return { accounts: accounts.length, needReconnect: broken.length };
  },
});

/** Queued by the worker for provider `post.*` webhooks (e.g. Zernio's `webhookJob`). */
export const postEventJob = defineNativeJob({
  id: "publishing.post-event",
  kind: "native",
  agent: "publisher",
  description: "Applies a post status update from your publisher (scheduled, live, failed) to the post and its content.",
  input: z.object({
    event: z.looseObject({
      type: z.string(),
      providerPostId: z.string().optional(),
      idempotencyKey: z.string().optional(),
      platforms: z.array(z.looseObject({ platform: z.enum(PLATFORMS).optional(), status: z.string().optional(), platformPostId: z.string().optional(), url: z.string().optional(), error: z.string().optional() })).optional(),
    }),
  }),
  async run(ctx) {
    const post = await applyPublishEvent(ctx.ws, ctx.input.event);
    return post ? { postId: post.id, status: post.status } : { ignored: true };
  },
});

export const jobs = [scheduleWeekJob, publishDueJob, crossPostJob, syncAccountsJob, postEventJob];

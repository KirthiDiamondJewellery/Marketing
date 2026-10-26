import { z } from "zod";
import { PLATFORMS, defineLlmJob, defineNativeJob } from "@attentionos/core";
import { activatePending } from "../lib/chain.ts";
import { verdictBatchSchema } from "../lib/classify.ts";
import { handoffLead } from "../lib/leads.ts";
import { applyTriageVerdicts, classifyInput, CLASSIFY_JOB, draftCommentReplies, ingestInboxEvent, sendApproved, triageInbox, type InboxEventLike } from "../lib/triage.ts";

export const dmTriageJob = defineNativeJob({
  id: "community.dm-triage",
  kind: "native",
  agent: "community",
  description: "Reads new DMs, filters spam and automation noise with rules, reuses cached verdicts and queues the rest for AI sorting. Never sends.",
  input: z.object({}),
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const s = await triageInbox(ctx.ws, { runId: ctx.runId });
    const parts = [
      `${s.threads} conversation${s.threads === 1 ? "" : "s"} checked`, s.spam && `${s.spam} spam`, s.auto && `${s.auto} need no reply`,
      s.queuedForAi && `${s.queuedForAi} sent for sorting`, s.cached && `${s.cached} unchanged`, s.aged && `${s.aged} cooled down`,
    ].filter(Boolean);
    await ctx.progress(`DMs: ${parts.join(", ")}`);
    return s;
  },
});

export const dmClassifyJob = defineLlmJob({
  id: CLASSIFY_JOB,
  kind: "llm",
  agent: "community",
  description: "Sorts a batch of DMs into hot, warm and cold and drafts replies. Runs with no tools because DMs are untrusted.",
  skill: "dm-triage",
  input: z.object({ itemIds: z.array(z.string().uuid()).min(1).max(50) }),
  toolless: true,
  allowedTools: [],
  defaultModel: "sonnet",
  // The structured answer takes its own step on the Claude Code engine, so one turn always fails.
  maxTurns: 3,
  budgetUsd: 0.25,
  output: verdictBatchSchema,
  async prompt(ctx) {
    return (await classifyInput(ctx.ws, ctx.input.itemIds)).prompt;
  },
  async onOutput(ctx, output) {
    const res = await applyTriageVerdicts(ctx.ws, output);
    if (res.errors.length) throw new Error(res.errors.join("; "));
    await ctx.progress(`Sorted ${res.applied} DM${res.applied === 1 ? "" : "s"}${res.drafts ? `, ${res.drafts} draft repl${res.drafts === 1 ? "y" : "ies"} waiting for you` : ""}`);
  },
});

export const commentRepliesJob = defineNativeJob({
  id: "community.comment-replies",
  kind: "native",
  agent: "community",
  description: "Drafts public replies to new comments from your rotating reply bank. Drafts only.",
  input: z.object({ days: z.number().int().min(1).max(30).default(7) }),
  async run(ctx) {
    const s = await draftCommentReplies(ctx.ws, { days: ctx.input.days });
    await ctx.progress(s.noBank ? "Comment replies: add a few replies to your reply bank first" : `Comments: ${s.drafted} repl${s.drafted === 1 ? "y" : "ies"} drafted across ${s.posts} post${s.posts === 1 ? "" : "s"}`);
    return s;
  },
});

export const activateAutomationsJob = defineNativeJob({
  id: "community.activate-automations",
  kind: "native",
  agent: "community",
  description: "Turns on keyword DM automations once they're approved and their post is live.",
  input: z.object({}),
  async run(ctx) {
    const s = await activatePending(ctx.ws, ctx.runId);
    if (s.active || s.failed) await ctx.progress(`Keyword DMs: ${s.active} turned on${s.failed ? `, ${s.failed} failed` : ""}`);
    return s;
  },
});

export const sendApprovedJob = defineNativeJob({
  id: "community.send-approved",
  kind: "native",
  agent: "community",
  description: "Sends replies you approved.",
  input: z.object({}),
  async run(ctx) {
    const s = await sendApproved(ctx.ws, ctx.runId);
    if (s.sent || s.failed) await ctx.progress(`Sent ${s.sent} approved repl${s.sent === 1 ? "y" : "ies"}${s.failed ? `, ${s.failed} failed` : ""}`);
    return s;
  },
});

/** Queued by the worker for inbox webhooks (`message.received`, `comment.received`, `conversation.started`). */
export const inboxEventJob = defineNativeJob({
  id: "community.inbox-event",
  kind: "native",
  agent: "community",
  description: "Files a new DM or comment from your inbox provider into triage (rules only; sorting happens in the next triage run).",
  input: z.object({ event: z.looseObject({ type: z.string() }) }),
  async run(ctx) {
    const row = await ingestInboxEvent(ctx.ws, ctx.input.event as InboxEventLike);
    return row ? { itemId: row.id, prefilter: row.prefilter, status: row.status } : { ignored: true };
  },
});

/** Queued by the worker when a DM automation reports an email (e.g. Blotato's `{email, isFollower}` webhook). */
export const leadCapturedJob = defineNativeJob({
  id: "community.lead-captured",
  kind: "native",
  agent: "community",
  description: "Saves a lead captured by a keyword DM and sends it to your CRM.",
  input: z.object({
    email: z.string().email(),
    isFollower: z.boolean().optional(),
    keyword: z.string().max(40).optional(),
    postRef: z.string().max(200).optional(),
    utmContent: z.string().max(120).optional(),
    platform: z.enum(PLATFORMS).default("instagram"),
    source: z.string().min(1).max(120).default("keyword DM"),
  }),
  async run(ctx) {
    const { email, keyword, utmContent, platform, source, isFollower } = ctx.input;
    let utm = utmContent;
    if (!utm && keyword) {
      const [row] = await ctx.ws.sql<{ utm_content: string | null }[]>`
        select p.utm_content from keywords k join posts p on p.content_id = k.content_id and p.workspace_id = k.workspace_id
         where k.workspace_id = ${ctx.ws.id} and k.word = ${keyword} and p.utm_content is not null order by p.created_at limit 1`;
      utm = row?.utm_content ?? undefined;
    }
    const res = await handoffLead(ctx.ws, {
      email, platform, source, temperature: "warm",
      ...(keyword ? { keyword } : {}), ...(utm ? { utmContent: utm } : {}),
      ...(isFollower !== undefined ? { notes: isFollower ? "Follows the account." : "Doesn't follow the account yet." } : {}),
    });
    await ctx.progress(res.message);
    return res;
  },
});

export const jobs = [dmTriageJob, dmClassifyJob, commentRepliesJob, activateAutomationsJob, sendApprovedJob, inboxEventJob, leadCapturedJob];

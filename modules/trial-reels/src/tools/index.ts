import { z } from "zod";
import { defineTool, ToolError, type ToolDefinition } from "@attentionos/core";
import { enqueueRun } from "@attentionos/db";
import { BatchError, createBatch, getBatch, recentBatches, trialSources } from "../repo.ts";
import { batchView, cancelBatch, JOB_IDS, scheduleBatch } from "../service.ts";
import { trialReelsSettings } from "../settings.ts";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export const sourcesTool = defineTool({
  name: "trial_reels_sources",
  description:
    "What trial reels can be made from: finished or approved edits (rf-12; rendered clean, without captions or title) and clean reels the owner uploaded for trial reels. Each comes with its date, the piece's title, suggested topic hashtags and, when the video asks for a comment, the owner's caption line with the keyword. Also returns the daily total and posting window. Use it to find e.g. \"yesterday's video\".",
  input: z.object({ days: z.number().int().min(1).max(90).default(14) }),
  annotations: { readOnly: true, idempotent: true },
  async handler({ ws }, input) {
    const s = trialReelsSettings(ws.config);
    return { sources: await trialSources(ws, { days: input.days }), dailyTotal: s.dailyTotal, window: s.window, graduation: s.graduation, timezone: ws.config.workspace.timezone };
  },
});

export const makeTool = defineTool({
  name: "trial_reels_make",
  description:
    "Make a day of Instagram trial reels from 1 or more clean videos (the day's total, 9 by default, is split evenly). Each variation is the same video with a different speed (up to 1.1x), colour, caption style, title style and wording, position and 5 reshuffled hashtags. Renders and checks them in the background; schedules NOTHING. Titles: the owner's own title first (ask for it if they didn't give one), then optional light reorders of the SAME words (other words are refused). The caption line is the owner's, word for word (needed with the keyword when the video asks for a comment). Never invent a hook or call to action.",
  input: z.object({
    videos: z.array(z.object({
      editRef: z.string().regex(/^rf-\d+$/i).optional().describe("A finished or approved edit (rendered clean for this)."),
      uploadAssetId: z.string().uuid().optional().describe("A clean reel the owner uploaded for trial reels."),
      title: z.string().max(90).describe("The owner's own title. Empty string = no title on screen."),
      otherWordings: z.array(z.string().max(90)).max(3).default([]).describe("Light reorders of the owner's title using the same words."),
      captionLine: z.string().max(2000).optional().describe("The owner's caption line, word for word. Omit for hashtags only."),
      hashtags: z.array(z.string()).min(5).max(30).describe("5 to 10 single-word hashtags about the video's topic. Each post gets 5, reshuffled."),
      layout: z.enum(["talking-head", "split-screen"]).default("talking-head"),
      endAsk: z.string().max(120).optional().describe("On-screen text near the end when the video asks for a comment, e.g. 'Comment GUIDE for the setup'. The owner's words."),
    })).min(1).max(10),
    day: day.optional().describe("The day the trial reels post (workspace timezone). Default: tomorrow."),
    total: z.number().int().min(1).max(50).optional().describe("Trial reels that day in total. Default: the daily total setting (9)."),
  }),
  async handler({ ws, actor }, input) {
    const reels = input.videos.map((v) => {
      if (Boolean(v.editRef) === Boolean(v.uploadAssetId)) throw new ToolError("Give each video either an editRef or an uploadAssetId.");
      return {
        source: v.editRef ? { kind: "edit" as const, editRef: v.editRef } : { kind: "upload" as const, assetId: v.uploadAssetId! },
        titles: [v.title, ...v.otherWordings].filter((t) => t.trim()),
        captionLine: v.captionLine ?? null,
        hashtags: v.hashtags,
        layout: v.layout,
        cta: v.endAsk ? { text: v.endAsk } : null,
      };
    });
    let batch;
    try {
      batch = await createBatch(ws, { reels, createdBy: actor, ...(input.day ? { date: input.day } : {}), ...(input.total ? { total: input.total } : {}) });
    } catch (err) {
      if (err instanceof BatchError) throw new ToolError(err.message, err.fix);
      throw err;
    }
    await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: JOB_IDS.make, agent: "publisher", input: { batchId: batch.id }, trigger: "manual", createdBy: actor, dedupeKey: `trial-reels:make:${batch.id}` });
    return {
      ref: batch.ref,
      day: batch.post_date,
      total: batch.total,
      message: `Making ${batch.total} trial reels for ${batch.post_date} (${batch.ref}). They render and get checked in the background; check progress with trial_reels_status. Nothing is scheduled until the owner OKs the preview.`,
    };
  },
});

export const statusTool = defineTool({
  name: "trial_reels_status",
  description: "A trial-reel batch in plain words: progress, the check results, the preview image path, the posting plan (times, titles, captions) and what was sent. Without a ref: the latest batches.",
  input: z.object({ ref: z.string().optional().describe("Batch ref like tr-3.") }),
  annotations: { readOnly: true, idempotent: true },
  async handler({ ws }, input) {
    if (input.ref) {
      const batch = await getBatch(ws, input.ref);
      if (!batch) throw new ToolError(`There is no trial-reel batch called ${input.ref}.`);
      return batchView(ws, batch);
    }
    const rows = await recentBatches(ws, 5);
    return { batches: rows.map((b) => ({ ref: b.ref, day: b.post_date, status: b.status, total: b.total, reels: b.sources.map((s) => s.name), problem: b.error ?? undefined })) };
  },
});

export const scheduleTool = defineTool({
  name: "trial_reels_schedule",
  description:
    "Schedule a checked batch as Instagram TRIAL reels only (never the main grid), spread across the posting window, alternating videos, under the 24-hour cap. dryRun=true (default) returns the plan and sends nothing: show the owner the preview image, how many per video, the titles, the times and one sample caption, and wait. With dryRun=false it asks the OWNER to approve the batch (an approval card with the preview); nothing is scheduled until they approve it in Studio or their notifications. You can't approve it yourself. The first time on an account only one goes out, right away, so the owner can check it stayed off their grid.",
  input: z.object({ ref: z.string(), dryRun: z.boolean().default(true) }),
  annotations: { openWorld: true },
  async handler({ ws, actor }, input) {
    const batch = await getBatch(ws, input.ref);
    if (!batch) throw new ToolError(`There is no trial-reel batch called ${input.ref}.`);
    if (input.dryRun) return scheduleBatch(ws, { batchId: batch.id, dryRun: true, actor });
    const run = await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: JOB_IDS.schedule, agent: "publisher", input: { batchId: batch.id }, trigger: "manual", createdBy: actor });
    return { message: `Asked for the owner's OK on ${batch.ref}. It's scheduled only once they approve it.`, runId: run.id };
  },
});

export const cancelTool = defineTool({
  name: "trial_reels_cancel",
  description: "Cancel trial reels that aren't live yet: a whole batch (ref) or some posts (post ids). Also removes them from the publisher's schedule.",
  input: z.object({ ref: z.string().optional(), postIds: z.array(z.string().uuid()).max(60).optional() }),
  annotations: { destructive: true, openWorld: true },
  async handler({ ws }, input) {
    const res = await cancelBatch(ws, { ...(input.ref ? { batchId: input.ref } : {}), ...(input.postIds ? { postIds: input.postIds } : {}) });
    if (!res.ok && res.cancelled === 0) throw new ToolError(res.message);
    return res;
  },
});

export const tools = [sourcesTool, makeTool, statusTool, scheduleTool, cancelTool] as ToolDefinition[];

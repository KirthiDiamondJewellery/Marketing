import { z } from "zod";
import { defineNativeJob } from "@attentionos/core";
import { cancelBatch, JOB_IDS, makeBatch, scheduleBatch } from "../service.ts";

export const makeJob = defineNativeJob({
  id: JOB_IDS.make,
  kind: "native",
  agent: "publisher",
  description: "Makes a day of trial reels: renders every variation from the clean reels, checks each one and builds the preview. Schedules nothing.",
  input: z.object({ batchId: z.string().uuid() }),
  timeoutMs: 60 * 60_000,
  async run(ctx) {
    return makeBatch(ctx);
  },
});

export const scheduleJob = defineNativeJob({
  id: JOB_IDS.schedule,
  kind: "native",
  agent: "publisher",
  description: "Schedules a checked batch of trial reels on Instagram (trial only) after the owner's OK, under the daily cap, never twice.",
  input: z.object({
    batchId: z.string().uuid(),
    dryRun: z.boolean().default(false),
    /** Set by the queue when the owner decides the batch approval. */
    approval: z.looseObject({ ref: z.string(), decision: z.string() }).optional(),
  }),
  timeoutMs: 30 * 60_000,
  async run(ctx) {
    if (ctx.input.approval && ctx.input.approval.decision !== "approved") {
      await ctx.progress("Trial reels not scheduled: you didn't approve them.");
      return { ok: false, message: "Not approved, so nothing was scheduled." };
    }
    const res = await scheduleBatch(ctx.ws, { batchId: ctx.input.batchId, dryRun: ctx.input.dryRun, runId: ctx.runId, actor: ctx.actor });
    await ctx.progress(res.message.split("\n")[0]!);
    return res;
  },
});

export const cancelJob = defineNativeJob({
  id: JOB_IDS.cancel,
  kind: "native",
  agent: "publisher",
  description: "Cancels trial reels that aren't live yet, also with the publisher.",
  input: z.object({ batchId: z.string().optional(), postIds: z.array(z.string().uuid()).max(60).optional() }),
  async run(ctx) {
    const res = await cancelBatch(ctx.ws, { ...(ctx.input.batchId ? { batchId: ctx.input.batchId } : {}), ...(ctx.input.postIds ? { postIds: ctx.input.postIds } : {}) });
    await ctx.progress(res.message);
    return res;
  },
});

export const jobs = [makeJob, scheduleJob, cancelJob];

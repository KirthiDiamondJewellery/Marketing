import { defineNativeJob } from "@attentionos/core";
import { z } from "zod";
import { runAdvance } from "../advance.ts";
import { runMatchUpload } from "../match-upload.ts";
import { runScheduleApproved } from "../release.ts";

export const JOB_IDS = {
  matchUpload: "production.match-upload",
  advance: "production.advance",
  scheduleApproved: "production.schedule-approved",
} as const;

/** `production.match-upload`: probe, cover frame, transcript of the first minute, ranked scripts, auto-link when clear. */
export const matchUploadJob = defineNativeJob({
  kind: "native",
  id: JOB_IDS.matchUpload,
  agent: "art_director",
  description: "Listens to the start of an uploaded take and finds the script it belongs to.",
  input: z.object({ uploadId: z.string().uuid() }),
  timeoutMs: 10 * 60_000,
  run: (ctx) => runMatchUpload(ctx),
});

/** `production.advance`: moves every in-flight edit one step (cuts → plan → render → approval → schedule). */
export const advanceJob = defineNativeJob({
  kind: "native",
  id: JOB_IDS.advance,
  agent: "art_director",
  description: "Keeps the edit queue moving: approves cuts when review is off, renders saved plans, schedules approved videos.",
  input: z.object({ reason: z.string().optional() }).passthrough(),
  timeoutMs: 5 * 60_000,
  run: (ctx) => runAdvance(ctx),
});

/** `production.schedule-approved`: one post per platform for an approved video, through the publishing module. */
export const scheduleApprovedJob = defineNativeJob({
  kind: "native",
  id: JOB_IDS.scheduleApproved,
  agent: "publisher",
  description: "Schedules an approved video on each of your platforms at the next open slot.",
  input: z.object({ ref: z.string().regex(/^rf-\d+$/i), version: z.number().int().positive().optional() }),
  timeoutMs: 10 * 60_000,
  run: (ctx) => runScheduleApproved(ctx),
});

export const productionJobs = [matchUploadJob, advanceJob, scheduleApprovedJob];

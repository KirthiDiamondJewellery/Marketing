import { defineNativeJob } from "@attentionos/core";
import { enqueueRun } from "@attentionos/module-research";
import { z } from "zod";
import { pendingOwnTranscripts } from "../lib/own-posts.ts";
import { readState } from "../lib/state.ts";

export const voiceReadyInput = z.object({
  kickoff: z.string().max(40).default("manual"),
  /** Start the voice profile now even if transcripts are still pending (the fallback timer, or nothing to transcribe). */
  force: z.boolean().default(false),
});

/**
 * The check-in after each of the owner's videos is transcribed (the `then` of the transcription hand-off): once no
 * own transcript is pending, it queues the voice profile, exactly once per setup run (the dedupe key holds the
 * kickoff id). Also queued with `force` as a timer, so a stuck transcription never blocks the draft.
 */
export const voiceReadyJob = defineNativeJob({
  kind: "native",
  id: "onboarding.voice-ready",
  agent: "copywriter",
  description: "Starts your voice profile once your own videos are transcribed.",
  input: voiceReadyInput,
  timeoutMs: 60_000,
  async run(ctx) {
    const { ws } = ctx;
    const state = await readState(ws.sql, ws.id);
    if (state?.data.voice.draft && state.data.voice.kickoff === ctx.input.kickoff) return { skipped: "already_drafted" };
    const dedupeKey = `onboarding:voice:${ctx.input.kickoff}`;
    // The queue only dedupes active runs; one voice draft per setup run, even after the first one finished.
    const [earlier] = await ws.sql`select id from agent_runs where workspace_id = ${ws.id} and dedupe_key = ${dedupeKey} limit 1`;
    if (earlier) return { skipped: "already_queued" };
    const pending = await pendingOwnTranscripts(ws.sql, ws.id);
    if (pending > 0 && !ctx.input.force) return { waiting: pending };
    const id = await enqueueRun(ws, {
      jobId: "onboarding.voice-profile",
      agent: "copywriter",
      input: { kickoff: ctx.input.kickoff },
      dedupeKey,
      parentRunId: ctx.runId,
      createdBy: "agent:copywriter",
    });
    if (id) await ctx.progress(pending ? `Starting your voice profile now; ${pending} video${pending === 1 ? " is" : "s are"} still being transcribed` : "Your videos are in. Learning your voice next");
    return { queued: Boolean(id), pending };
  },
});

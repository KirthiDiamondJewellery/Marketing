import { defineNativeJob, type WorkspaceContext } from "@attentionos/core";
import { spokenHook } from "@attentionos/scoring";
import { ingestTranscriptInputSchema, type IngestTranscriptInput } from "../handoff.ts";
import { enqueueRun } from "../lib/ops.ts";
import { saveTranscript, setTranscriptStatus } from "../repo/externalPosts.ts";

export async function ingestTranscript(ws: WorkspaceContext, input: IngestTranscriptInput, runId?: string | null): Promise<{ saved: boolean; spokenHook?: string; continued: boolean }> {
  let saved = false;
  let hook: string | undefined;
  if (input.transcript && input.transcript.text.trim()) {
    hook = spokenHook(input.transcript.text);
    saved = await saveTranscript(ws, input.externalPostId, { transcript: input.transcript.text.trim(), spokenHook: hook, mediaPath: input.mediaPath ?? null });
    if (input.transcript.durationS) {
      await ws.sql`update external_posts set duration_s = coalesce(duration_s, ${input.transcript.durationS}) where workspace_id = ${ws.id} and id = ${input.externalPostId}`;
    }
  } else {
    await setTranscriptStatus(ws, input.externalPostId, input.error?.kind ?? "failed");
  }
  let continued = false;
  if (input.then) {
    continued = (await enqueueRun(ws, { jobId: input.then.jobId, agent: input.then.agent, input: input.then.input, parentRunId: runId ?? null, createdBy: "agent:analyst" })) !== null;
  }
  return { saved, ...(hook ? { spokenHook: hook } : {}), continued };
}

export const ingestTranscriptJob = defineNativeJob({
  kind: "native",
  id: "research.ingest-transcript",
  agent: "analyst",
  description: "Stores a competitor post's transcript and its spoken hook.",
  input: ingestTranscriptInputSchema,
  async run(ctx) {
    const r = await ingestTranscript(ctx.ws, ctx.input, ctx.runId);
    await ctx.progress(r.saved ? "Saved the transcript and spoken hook" : "No transcript came back for this post");
    return r;
  },
});

import { defineLlmJob, defineNativeJob } from "@attentionos/core";
import { z } from "zod";
import { planPrompt, revisePrompt } from "../prompts.ts";
import { JOB_IDS, recordRevisionNote, revisionSessionId, runPrep, runRender, type ApprovalInput } from "../service.ts";
import { runTranscribe, transcribeInput } from "../transcribe.ts";

const ref = z.string().regex(/^rf-\d+$/i, "an edit ref like rf-12").transform((s) => s.toLowerCase());
/** Present when the runner re-queues a run after the owner decided its approval. */
const approval = z.object({ ref: z.string(), decision: z.enum(["approved", "rejected", "revised"]), note: z.string().nullable().optional() }).optional();

const TOOL = (name: string) => `mcp__attentionos__${name}`;
const PLAN_TOOLS = ["editing_get_edit_job", "editing_get_plan", "editing_save_plan", "editing_request_render"].map(TOOL);

export const planOutput = z.object({ ref: z.string(), saved: z.boolean(), summary: z.string() });

/** `editing.prep`: prep + ASR + cut plan → edit_jobs row in review with the cut list, then a notification. */
export const prepJob = defineNativeJob({
  kind: "native",
  id: JOB_IDS.prep,
  agent: "art_director",
  description: "Prepares raw footage: proxy, transcript, silence map and a cut list to review.",
  input: z.object({ ref, approval }),
  timeoutMs: 30 * 60_000,
  heavy: true,
  run: (ctx) => runPrep(ctx as never),
});

/** `editing.plan`: the Art Director writes the EditPlan from the format template, transcript and house style. */
export const planJob = defineLlmJob({
  kind: "llm",
  id: JOB_IDS.plan,
  agent: "art_director",
  description: "Writes the edit plan from the format template, the transcript and your house style.",
  input: z.object({ ref }),
  skill: "reel-editor",
  defaultModel: "opus",
  maxTurns: 14,
  budgetUsd: 0.5,
  timeoutMs: 10 * 60_000,
  allowedTools: ["Read", ...PLAN_TOOLS],
  output: planOutput,
  prompt: (ctx) => planPrompt(ctx.input.ref),
});

/** `editing.render`: render → finish → QC → final preflight → output asset → approval request. */
export const renderJob = defineNativeJob({
  kind: "native",
  id: JOB_IDS.render,
  agent: "art_director",
  description: "Renders the edit, normalises loudness, runs QC and sends it for approval.",
  input: z.object({ ref, version: z.number().int().positive().optional(), approval }),
  timeoutMs: 40 * 60_000,
  heavy: true,
  run: (ctx) => runRender(ctx as never),
});

/**
 * `editing.revise`: notes like "rf-12 v2 tighten the hook" (from chat via the ops module, an approval decision, or
 * editing_add_revision_note). Input matches what ops enqueues: { ref, fromVersion, notes, attachments?, source }.
 * Continues the edit's earlier Art Director session via `resumeSession`.
 */
export const reviseInput = z.object({
  ref,
  fromVersion: z.number().int().positive(),
  notes: z.string(),
  attachments: z.array(z.object({ url: z.string().optional(), kind: z.string(), fileName: z.string().optional() }).passthrough()).optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export const reviseJob = defineLlmJob({
  kind: "llm",
  id: JOB_IDS.revise,
  agent: "art_director",
  description: "Applies your revision notes to an edit and re-renders only what changed.",
  input: reviseInput,
  skill: "edit-notes",
  defaultModel: "opus",
  maxTurns: 12,
  budgetUsd: 0.5,
  timeoutMs: 10 * 60_000,
  allowedTools: ["Read", ...PLAN_TOOLS],
  resumeSession: (ctx) => revisionSessionId(ctx.ws, ctx.input),
  output: planOutput,
  prompt: async (ctx) => {
    await recordRevisionNote(ctx.ws, ctx.input, ctx.actor);
    return revisePrompt(ctx.input);
  },
});

/** `editing.transcribe`: research hand-off (TranscriptionRequest in, research.ingest-transcript out). */
export const transcribeJob = defineNativeJob({
  kind: "native",
  id: JOB_IDS.transcribe,
  agent: "art_director",
  description: "Transcribes a post for research and hands the transcript back.",
  input: transcribeInput,
  timeoutMs: 20 * 60_000,
  heavy: true,
  run: (ctx) => runTranscribe(ctx),
});

export const editingJobs = [prepJob, planJob, renderJob, reviseJob, transcribeJob];

export type { ApprovalInput };

import { defineLlmJob, type WorkspaceContext } from "@attentionos/core";
import { z } from "zod";
import { updateState } from "../lib/state.ts";
import { interviewTurnOutput, readModelOutput } from "../schemas.ts";

export const interviewInput = z.object({
  /** The owner's message id (Studio), or "start" for the opening question. */
  messageId: z.string().min(1).max(80),
  text: z.string().max(4000).default(""),
  start: z.boolean().default(false),
});

/** The latest interview session, so each turn continues the same conversation. */
export async function interviewSession(ws: WorkspaceContext): Promise<string | undefined> {
  const rows = await ws.sql<{ session_id: string }[]>`
    select session_id from agent_runs
     where workspace_id = ${ws.id} and job_id = 'onboarding.interview' and status = 'succeeded' and session_id is not null
     order by finished_at desc nulls last limit 1`;
  return rows[0]?.session_id;
}

const TOOLS = [
  "Read",
  "mcp__attentionos__onboarding_get_state",
  "mcp__attentionos__onboarding_record_answer",
  // From the knowledge module (when installed): what the owner already wrote, so the interview never asks twice.
  "mcp__attentionos__knowledge_search",
];

/**
 * Step 3 of setup: one turn of the Chief of Staff's onboarding interview (customers' pains in their own words, offers,
 * objections, proof). The owner is waiting in Studio, so each run answers with one reaction and one question. Facts go
 * into the onboarding state through `onboarding_record_answer` (numbers need a source); the owner saves them to the
 * Brand Kit from Studio. Each turn resumes the previous session.
 */
export const interviewJob = defineLlmJob({
  kind: "llm",
  id: "onboarding.interview",
  agent: "chief_of_staff",
  description: "Interviews you about your customers, offers, objections and proof.",
  input: interviewInput,
  skill: "onboarding-interview",
  allowedTools: TOOLS,
  defaultModel: "sonnet",
  maxTurns: 12,
  budgetUsd: 0.4,
  timeoutMs: 4 * 60_000,
  resumeSession: (ctx) => (ctx.input.start ? Promise.resolve(undefined) : interviewSession(ctx.ws)),
  prompt(ctx) {
    const live = "This is a LIVE setup interview: the owner is waiting in Studio for your reply. Asking questions is the job here.";
    if (ctx.input.start) {
      return [
        live,
        "Start the onboarding interview. Follow the onboarding-interview skill.",
        "1. Call onboarding_get_state to see what the owner already approved (business, offers, voice) and any answers already recorded.",
        "2. Read brand/icp.md and brand/offers.md if they exist (knowledge_search finds anything else the owner already wrote).",
        "3. Reply with one short line on what you already know, then your first question (customers' problems, in their words).",
        'Your final message is JSON only, no other text: {"reply": "...", "done": false}.',
      ].join("\n");
    }
    return [
      live,
      "The owner answered:",
      "<owner_message>",
      ctx.input.text,
      "</owner_message>",
      "Record each distinct fact with onboarding_record_answer (numbers only with the source the owner gave). Then reply with a short reaction and the next question, following the skill's order.",
      "When every topic is covered (or the owner wants to stop), reply with the summary from the skill and set done: true.",
      'Your final message is JSON only, no other text: {"reply": "...", "done": false|true}.',
    ].join("\n");
  },
  async onOutput(ctx, output) {
    const out = readModelOutput(interviewTurnOutput, output);
    const reply = out.reply.trim().slice(0, 6000) || "Noted. What else should the team know?";
    const at = ctx.ws.now().toISOString();
    await updateState(ctx.ws.sql, ctx.ws.id, (s) => {
      const id = `agent-${ctx.input.messageId}`;
      if (s.data.interview.messages.some((m) => m.id === id)) return s;
      const messages = [...s.data.interview.messages, { id, role: "agent" as const, text: reply, at }].slice(-200);
      return { ...s, data: { ...s.data, interview: { ...s.data.interview, messages, done: s.data.interview.done || out.done, runId: ctx.runId } } };
    });
  },
});

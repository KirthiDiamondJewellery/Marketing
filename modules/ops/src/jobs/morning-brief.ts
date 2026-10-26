import { defineLlmJob, defineNativeJob } from "@attentionos/core";
import { z } from "zod";
import { opsSettings } from "../settings.ts";
import { composeBrief } from "../lib/brief.ts";
import { loadBriefData } from "../lib/brief-data.ts";
import { dispatchOutbox, enqueueMessage } from "../lib/outbox.ts";
import { loadMasker } from "../lib/store.ts";

/** Dedupe key shared by the written and the fallback brief, so the owner gets exactly one per day. */
export const briefDedupeKey = (date: string) => `brief:${date}`;

/**
 * Deterministic morning brief (no LLM). Scheduled after `ops.write-morning-brief`: when the written brief was
 * already sent today, the shared dedupe key makes this a no-op; otherwise this one goes out instead.
 */
export const morningBriefJob = defineNativeJob({
  id: "ops.morning-brief",
  kind: "native",
  agent: "chief_of_staff",
  description: "Sends the morning brief: what to film, what's waiting for you, results and alerts.",
  input: z.object({ force: z.boolean().default(false) }),
  timeoutMs: 60_000,
  async run(ctx) {
    const { ws } = ctx;
    const data = await loadBriefData(ws);
    const masker = await loadMasker(ws);
    const brief = composeBrief(data, { mask: masker.text, maxApprovals: opsSettings(ws.config).briefApprovals });
    const queued = await enqueueMessage(ws, {
      text: brief.markdown,
      format: "markdown",
      priority: "normal",
      dedupeKey: ctx.input.force ? `${briefDedupeKey(data.date)}:${ws.now().getTime()}` : briefDedupeKey(data.date),
      ...(data.approvals.total ? { actions: [{ id: "approvals", label: `Review ${data.approvals.total} waiting` }] } : {}),
    });
    if (!queued) {
      await ctx.progress("Today's brief was already sent");
      return { sent: false, reason: "already sent today" };
    }
    const delivery = await dispatchOutbox(ws);
    await ctx.progress(delivery.held ? "Brief is ready and will arrive when quiet hours end" : "Sent the morning brief");
    return { sent: true, sections: brief.sections.map((s) => s.name), delivery };
  },
});

/** Autopilot: the Chief of Staff writes the brief in the owner's voice, from the same data. */
export const writeMorningBriefJob = defineLlmJob({
  id: "ops.write-morning-brief",
  agent: "chief_of_staff",
  description: "The Chief of Staff writes today's brief from the daily plan, approvals, results and alerts.",
  input: z.object({}),
  kind: "llm",
  skill: "morning-brief",
  defaultModel: "sonnet",
  maxTurns: 8,
  budgetUsd: 0.25,
  allowedTools: [
    "Read",
    "mcp__attentionos__ops_get_morning_brief",
    "mcp__attentionos__ops_list_approvals",
    "mcp__attentionos__ops_send_notification",
  ],
  prompt(ctx) {
    const date = ctx.ws.now().toISOString().slice(0, 10);
    return [
      "Write and send today's morning brief, following the morning-brief skill.",
      "1. Call ops_get_morning_brief with format \"both\" for today's facts.",
      "2. Read brand/voice.md only for tone; the brief is for the owner, not the audience.",
      `3. Send it once with ops_send_notification, format "markdown", dedupeKey "brief:<date from the brief data>" (today is about ${date}).`,
      "Use only numbers that appear in the tool output. If a section is empty, leave it out.",
    ].join("\n");
  },
});

import { defineNativeJob } from "@attentionos/core";
import { z } from "zod";
import { opsSettings } from "../settings.ts";
import { announceNewApprovals } from "../lib/approvals.ts";
import { dispatchOutbox } from "../lib/outbox.ts";

/** Every minute: announce new approvals with buttons, then deliver queued messages. */
export const dispatchOutboxJob = defineNativeJob({
  id: "ops.dispatch-outbox",
  kind: "native",
  agent: "chief_of_staff",
  description: "Delivers queued messages to Telegram or Discord, holding non-urgent ones during quiet hours.",
  input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  timeoutMs: 120_000,
  async run(ctx) {
    const { ws } = ctx;
    if (!ws.providers.notifier) return { skipped: "no notifier configured" };
    const announced = opsSettings(ws.config).notifyApprovals ? await announceNewApprovals(ws) : 0;
    const result = await dispatchOutbox(ws, ctx.input.limit ? { limit: ctx.input.limit } : {});
    if (result.sent || announced) await ctx.progress(`Sent ${result.sent} message${result.sent === 1 ? "" : "s"}`);
    return { announced, ...result };
  },
});

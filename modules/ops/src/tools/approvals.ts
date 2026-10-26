import { compact, defineTool, ToolError } from "@attentionos/core";
import { z } from "zod";
import { decideApproval, decisionReply, listApprovals } from "../lib/approvals.ts";
import { normalizeApprovalRef } from "../lib/refs.ts";

export const listApprovalsTool = defineTool({
  name: "ops_list_approvals",
  description:
    "Lists the approvals queue (the same queue Telegram, Discord and Studio show). Defaults to pending items, oldest first. Each item has a ref like ap-7, the agent, what it is and a summary. Set includePreview to see the draft text or file.",
  input: z.object({
    status: z.enum(["pending", "approved", "rejected", "revised", "expired", "all"]).default("pending"),
    kind: z.enum(["script", "edit", "post", "dm_reply", "comment_reply", "campaign", "spend", "brand_change", "other"]).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    includePreview: z.boolean().default(false),
  }),
  annotations: { readOnly: true, idempotent: true },
  async handler({ ws }, input) {
    return compact(await listApprovals(ws, input));
  },
});

export const decideApprovalTool = defineTool({
  name: "ops_decide_approval",
  description:
    "Records the OWNER's decision on an approval: approve, reject, or revise (request changes; a note is required). Only call this when the owner has clearly decided in this conversation; never decide on their behalf. " +
    "If the work was paused waiting for this decision, it resumes automatically. Deciding something already decided changes nothing.",
  input: z.object({
    ref: z.string().describe('Approval ref, e.g. "ap-7" (or just 7)'),
    decision: z.enum(["approve", "reject", "revise"]),
    note: z.string().max(2000).optional().describe("Why, or what to change. Required for revise."),
  }),
  annotations: { destructive: false, idempotent: true },
  async handler({ ws, actor }, input) {
    const ref = normalizeApprovalRef(input.ref);
    if (!ref) throw new ToolError(`"${input.ref}" isn't an approval ref.`, 'Use the ref shown in the queue, like "ap-7".');
    const r = await decideApproval(ws, { ref, decision: input.decision, ...(input.note ? { note: input.note } : {}), actor });
    return compact({ ...r, message: decisionReply(r) });
  },
});

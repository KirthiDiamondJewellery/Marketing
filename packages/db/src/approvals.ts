import { nextRef, type Actor, type AgentKey, type Sql } from "@attentionos/core";
import { agentColumn, recordAgentEvent } from "./events.ts";

export const APPROVAL_KINDS = ["script", "edit", "post", "dm_reply", "comment_reply", "campaign", "spend", "brand_change", "other"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "revised", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ApprovalDecision = "approved" | "rejected" | "revised";

export type ApprovalRow = {
  id: string;
  ref: string;
  kind: ApprovalKind;
  subject_type: string;
  subject_id: string | null;
  agent: string;
  status: ApprovalStatus;
  summary: string;
  preview: unknown;
  run_id: string | null;
  requested_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
};

export class ApprovalError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export type RequestApprovalInput = {
  kind: ApprovalKind;
  subjectType: string;
  subjectId?: string | null;
  agent: AgentKey | string;
  summary: string;
  preview?: Record<string, unknown> | null;
  runId?: string | null;
};

/**
 * Adds an item to the approvals queue every surface reads. A pending approval for the same subject and
 * kind is returned instead of creating a duplicate.
 */
export async function requestApproval(sql: Sql, workspaceId: string, input: RequestApprovalInput): Promise<{ approval: ApprovalRow; created: boolean }> {
  return sql.begin(async (tx) => {
    if (input.subjectId) {
      const [existing] = await tx<ApprovalRow[]>`
        select * from approvals
         where workspace_id = ${workspaceId} and status = 'pending' and kind = ${input.kind}
           and subject_type = ${input.subjectType} and subject_id = ${input.subjectId}
         limit 1`;
      if (existing) return { approval: existing, created: false };
    }
    const ref = await nextRef(tx as unknown as Sql, workspaceId, "ap");
    const [approval] = await tx<ApprovalRow[]>`
      insert into approvals (workspace_id, ref, kind, subject_type, subject_id, agent, summary, preview, run_id)
      values (${workspaceId}, ${ref}, ${input.kind}, ${input.subjectType}, ${input.subjectId ?? null}, ${input.agent},
              ${input.summary}, ${input.preview ? tx.json(input.preview as never) : null}, ${input.runId ?? null})
      returning *`;
    return { approval: approval!, created: true };
  });
}

export async function listApprovals(
  sql: Sql,
  workspaceId: string,
  opts: { status?: ApprovalStatus | "all"; kind?: ApprovalKind; limit?: number } = {},
): Promise<ApprovalRow[]> {
  const status = opts.status ?? "pending";
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return sql<ApprovalRow[]>`
    select * from approvals
     where workspace_id = ${workspaceId}
       ${status === "all" ? sql`` : sql`and status = ${status}`}
       ${opts.kind ? sql`and kind = ${opts.kind}` : sql``}
     order by requested_at ${status === "pending" ? sql`asc` : sql`desc`}
     limit ${limit}`;
}

export async function countPendingApprovals(sql: Sql, workspaceId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from approvals where workspace_id = ${workspaceId} and status = 'pending'`;
  return row?.n ?? 0;
}

/**
 * Records a person's decision. Agents can't decide (the human has the final word). If the approval belongs to a run
 * that is waiting on it, the run goes back on the queue with the decision in its input.
 */
export async function decideApproval(
  sql: Sql,
  workspaceId: string,
  input: { refOrId: string; decision: ApprovalDecision; actor: Actor; note?: string },
): Promise<ApprovalRow> {
  if (input.actor.startsWith("agent:")) {
    throw new ApprovalError("Only a person can approve or reject work.", "Ask the user to decide, e.g. in Claude Code or Telegram.");
  }
  const byId = /^[0-9a-f-]{36}$/i.test(input.refOrId);
  return sql.begin(async (tx) => {
    const [current] = await tx<ApprovalRow[]>`
      select * from approvals where workspace_id = ${workspaceId}
         and ${byId ? tx`id = ${input.refOrId}` : tx`ref = ${input.refOrId.toLowerCase()}`}
       for update`;
    if (!current) throw new ApprovalError(`No approval called ${input.refOrId}.`, "List pending approvals to see their refs (ap-12).");
    if (current.status !== "pending") throw new ApprovalError(`${current.ref} was already ${current.status}.`);
    const [row] = await tx<ApprovalRow[]>`
      update approvals set status = ${input.decision}, decided_at = now(), decided_by = ${input.actor}, decision_note = ${input.note ?? null}
       where workspace_id = ${workspaceId} and id = ${current.id} returning *`;
    if (current.run_id) {
      const decision = { ref: current.ref, decision: input.decision, note: input.note ?? null };
      await tx`
        update agent_runs
           set status = 'queued', run_after = now(), claimed_by = null,
               priority = greatest(priority, 100), -- a person decided: the run continues ahead of background work
               input = input || ${tx.json({ approval: decision } as never)}
         where id = ${current.run_id} and workspace_id = ${workspaceId} and status = 'waiting_approval'`;
    }
    await recordAgentEvent(tx as unknown as Sql, {
      workspaceId,
      agent: agentColumn(input.actor),
      kind: "approval",
      runId: current.run_id,
      message: `${input.decision === "approved" ? "Approved" : input.decision === "rejected" ? "Rejected" : "Asked for changes on"} ${current.ref}: ${current.summary}`,
      data: { ref: current.ref, decision: input.decision, note: input.note ?? null },
    });
    return row!;
  });
}

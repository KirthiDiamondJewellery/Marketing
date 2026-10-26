import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_MONOGRAMS, ToolError, type Actor, type AgentKey, type NotifyAction, type OutboundMessage, type WorkspaceContext } from "@attentionos/core";
import { enqueueMessage } from "./outbox.ts";
import { actionId, type Decision } from "./refs.ts";
import { addEvent, asJson, loadMasker } from "./store.ts";

/**
 * The approvals queue: every surface (Claude Code, Telegram, Discord, Studio) reads and decides the
 * same rows. A decision is idempotent: deciding an approval that's already decided returns its current state.
 *
 * Contract with other modules: a run that needs sign-off inserts an `approvals` row with `run_id` and sets
 * itself to `waiting_approval`. When the owner decides, ops puts that run back in the queue with
 * `input.approval = { ref, decision, note }`, so the job resumes and acts on the decision.
 */

export type ApprovalRow = {
  ref: string;
  kind: string;
  subject_type: string;
  subject_id: string | null;
  agent: string;
  status: string;
  summary: string;
  preview: Record<string, unknown> | null;
  run_id: string | null;
  requested_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
};

export const AGENT_NAMES: Record<AgentKey, string> = {
  analyst: "Analyst",
  strategist: "Strategist",
  copywriter: "Copywriter",
  art_director: "Art Director",
  publisher: "Publisher",
  community: "Community",
  chief_of_staff: "Chief of Staff",
};

export function agentName(agent: string): string {
  return (AGENT_NAMES as Record<string, string>)[agent] ?? agent;
}

const KIND_LABEL: Record<string, string> = {
  script: "script",
  edit: "edit",
  post: "post",
  dm_reply: "DM reply",
  comment_reply: "comment reply",
  campaign: "campaign",
  spend: "spend",
  brand_change: "Brand Kit change",
  other: "request",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export type ListedApproval = {
  ref: string;
  kind: string;
  agent: string;
  summary: string;
  status: string;
  requestedAt: string;
  preview?: Record<string, unknown>;
  decidedAt?: string;
  decisionNote?: string;
};

export async function listApprovals(
  ws: WorkspaceContext,
  opts: { status?: "pending" | "approved" | "rejected" | "revised" | "expired" | "all"; kind?: string; limit?: number; includePreview?: boolean } = {},
): Promise<{ total: number; items: ListedApproval[] }> {
  const status = opts.status ?? "pending";
  const limit = Math.min(opts.limit ?? 20, 100);
  const statusFilter = status === "all" ? ws.sql`` : ws.sql`and status = ${status}`;
  const kindFilter = opts.kind ? ws.sql`and kind = ${opts.kind}` : ws.sql``;
  const [rows, count] = await Promise.all([
    ws.sql<ApprovalRow[]>`
      select * from approvals where workspace_id = ${ws.id} ${statusFilter} ${kindFilter}
       order by requested_at ${status === "pending" ? ws.sql`asc` : ws.sql`desc`} limit ${limit}`,
    ws.sql<{ n: number }[]>`select count(*)::int as n from approvals where workspace_id = ${ws.id} ${statusFilter} ${kindFilter}`,
  ]);
  const masker = await loadMasker(ws);
  return {
    total: count[0]?.n ?? 0,
    items: rows.map((r) => ({
      ref: r.ref,
      kind: r.kind,
      agent: agentName(r.agent),
      summary: masker.text(r.summary),
      status: r.status,
      requestedAt: new Date(r.requested_at).toISOString(),
      ...(opts.includePreview && r.preview ? { preview: r.preview } : {}),
      ...(r.decided_at ? { decidedAt: new Date(r.decided_at).toISOString() } : {}),
      ...(r.decision_note ? { decisionNote: r.decision_note } : {}),
    })),
  };
}

const STATUS_FOR: Record<Decision, "approved" | "rejected" | "revised"> = { approve: "approved", reject: "rejected", revise: "revised" };

export type DecideResult = {
  ref: string;
  status: string;
  summary: string;
  agent: string;
  /** False when the approval had already been decided (nothing changed). */
  changed: boolean;
  /** True when a paused run was put back in the queue to act on the decision. */
  resumed: boolean;
};

export async function decideApproval(
  ws: WorkspaceContext,
  input: { ref: string; decision: Decision; note?: string; actor: Actor },
): Promise<DecideResult> {
  if (input.decision === "revise" && !input.note?.trim()) {
    throw new ToolError("Say what should change.", 'Add a note, for example "revise ap-7 shorter hook".');
  }
  return ws.sql.begin(async (tx) => {
    const rows = await tx<ApprovalRow[]>`select * from approvals where workspace_id = ${ws.id} and ref = ${input.ref} for update`;
    const row = rows[0];
    if (!row) throw new ToolError(`There's no approval ${input.ref}.`, 'Send "approvals" to see what is waiting.');
    if (row.status !== "pending") {
      return { ref: row.ref, status: row.status, summary: row.summary, agent: agentName(row.agent), changed: false, resumed: false };
    }
    const status = STATUS_FOR[input.decision];
    const note = input.note?.trim() || null;
    await tx`
      update approvals set status = ${status}, decided_at = now(), decided_by = ${input.actor}, decision_note = ${note}
       where workspace_id = ${ws.id} and ref = ${input.ref}`;
    let resumed = false;
    if (row.run_id) {
      const approval = { ref: row.ref, decision: input.decision, ...(note ? { note } : {}) };
      const updated = await tx`
        update agent_runs
           set status = 'queued', run_after = now(), priority = greatest(priority, 100), input = input || ${asJson(tx as never, { approval })}
         where workspace_id = ${ws.id} and id = ${row.run_id} and status = 'waiting_approval'
         returning id`;
      resumed = updated.length > 0;
    }
    const verb = { approved: "Approved", rejected: "Rejected", revised: "Changes requested for" }[status];
    await addEvent(tx as never, ws.id, {
      agent: row.agent,
      kind: "approval",
      runId: row.run_id,
      message: `${verb} ${row.ref}: ${row.summary}`,
      data: { ref: row.ref, decision: input.decision, by: input.actor },
    });
    return { ref: row.ref, status, summary: row.summary, agent: agentName(row.agent), changed: true, resumed };
  });
}

/** Plain-language confirmation for chat. */
export function decisionReply(r: DecideResult): string {
  if (!r.changed) return `${r.ref} was already ${r.status}. Nothing changed.`;
  if (r.status === "approved") return `Approved ${r.ref}: ${r.summary}. ${r.agent} will take it from here.`;
  if (r.status === "rejected") return `Rejected ${r.ref}: ${r.summary}. ${r.agent} won't use it.`;
  return `Sent your notes on ${r.ref} to ${r.agent}. You'll get a new version to review.`;
}

/** Buttons for an approval message. Edits are revised by replying with notes, so they get no revise button. */
export function approvalActions(ref: string): NotifyAction[] {
  return [
    { id: actionId("approve", ref), label: "Approve", style: "primary" },
    { id: actionId("reject", ref), label: "Reject", style: "danger" },
  ];
}

function previewText(preview: Record<string, unknown> | null): string | undefined {
  if (!preview) return undefined;
  for (const key of ["text", "caption", "hook", "body", "reply", "draft"]) {
    const v = preview[key];
    if (typeof v === "string" && v.trim()) return v.trim().length > 600 ? `${v.trim().slice(0, 597)}...` : v.trim();
  }
  return undefined;
}

function previewFile(ws: WorkspaceContext, preview: Record<string, unknown> | null): string | undefined {
  const p = preview?.mediaPath ?? preview?.file ?? preview?.localPath;
  if (typeof p !== "string") return undefined;
  const full = resolve(ws.paths.root, p);
  return existsSync(full) ? full : undefined;
}

/** The chat message for one approval: who, what, a preview, and approve/reject buttons. */
export function approvalMessage(ws: WorkspaceContext, row: Pick<ApprovalRow, "ref" | "kind" | "agent" | "summary" | "preview">, mask: (s: string) => string): OutboundMessage {
  const who = `*${agentName(row.agent)}* (${AGENT_MONOGRAMS[row.agent as AgentKey] ?? "··"}) · ${kindLabel(row.kind)}`;
  const preview = previewText(row.preview);
  const file = previewFile(ws, row.preview);
  const lines = [who, mask(row.summary)];
  if (preview) lines.push("", mask(preview));
  lines.push("", "Approve, reject, or reply with what you'd like changed.");
  return {
    text: lines.join("\n"),
    format: "markdown",
    ref: row.ref,
    actions: approvalActions(row.ref),
    dedupeKey: `approval:${row.ref}`,
    priority: "normal",
    ...(file ? { attachments: [{ localPath: file }] } : {}),
  };
}

/** Posts a message for every pending approval that hasn't been announced yet (dedupe key per ref). */
export async function announceNewApprovals(ws: WorkspaceContext, limit = 10): Promise<number> {
  const channel = ws.providers.notifier?.id ?? ws.config.providers.notifier;
  const rows = await ws.sql<ApprovalRow[]>`
    select a.* from approvals a
     where a.workspace_id = ${ws.id} and a.status = 'pending'
       and not exists (
         select 1 from messages m
          where m.workspace_id = a.workspace_id and m.channel = ${channel} and m.dedupe_key = 'approval:' || a.ref)
     order by a.requested_at
     limit ${limit}`;
  if (!rows.length) return 0;
  const masker = await loadMasker(ws);
  let n = 0;
  for (const row of rows) {
    if (await enqueueMessage(ws, approvalMessage(ws, row, masker.text))) n++;
  }
  return n;
}

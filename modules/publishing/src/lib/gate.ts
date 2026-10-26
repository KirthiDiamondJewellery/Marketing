import { agentSettings, type Actor, type AgentKey, type AutonomyLevel, type OutboundMessage, type WorkspaceContext } from "@attentionos/core";
import { recordAgentEvent, requestApproval, type ApprovalKind, type ApprovalRow } from "@attentionos/db";

/**
 * "Nothing goes public beyond the autonomy the user chose". Shared by publishing and community.
 *
 * - review_all (default): every public action waits for a person to approve it in the approvals queue.
 * - review_key: only key actions wait (campaign posts, offer posts, sensitive replies).
 * - autopilot: the agent acts and reports afterwards.
 *
 * Approval only ever comes from a decided row in `approvals` (people decide with core_decide_approval, Telegram or
 * the dashboard). Tool callers can't approve their own work, whoever the actor is.
 */

export function autonomyOf(ws: WorkspaceContext, agent: AgentKey): AutonomyLevel {
  return agentSettings(ws.config, agent).autonomy;
}

export function approvalRequired(level: AutonomyLevel, isKey: boolean): boolean {
  if (level === "review_all") return true;
  if (level === "review_key") return isKey;
  return false;
}

export type GateRequest = {
  agent: AgentKey;
  kind: ApprovalKind;
  subjectType: string;
  subjectId: string;
  /** Plain-language line shown on the approval card. */
  summary: string;
  preview?: Record<string, unknown>;
  /** Campaign/offer posts and sensitive replies count as key under review_key. */
  isKey: boolean;
  runId?: string | null;
};

export type GateResult =
  | { allowed: true; via: "autonomy" | "approved"; ref?: string }
  | { allowed: false; status: "pending" | "rejected"; ref: string; created: boolean; note?: string | null };

/** Latest approval for a subject (any status), newest first. */
export async function latestApproval(ws: WorkspaceContext, subjectType: string, subjectId: string, kind?: ApprovalKind): Promise<ApprovalRow | undefined> {
  const rows = await ws.sql<ApprovalRow[]>`
    select * from approvals
     where workspace_id = ${ws.id} and subject_type = ${subjectType} and subject_id = ${subjectId}
       ${kind ? ws.sql`and kind = ${kind}` : ws.sql``}
     order by requested_at desc
     limit 1`;
  return rows[0];
}

/**
 * Decides whether a public action may happen now. If it may not, makes sure exactly one pending approval exists
 * (a rejected item stays rejected until its content changes; "revised" opens a fresh request).
 */
export async function gate(ws: WorkspaceContext, req: GateRequest): Promise<GateResult> {
  if (!approvalRequired(autonomyOf(ws, req.agent), req.isKey)) return { allowed: true, via: "autonomy" };
  const latest = await latestApproval(ws, req.subjectType, req.subjectId, req.kind);
  if (latest?.status === "approved") return { allowed: true, via: "approved", ref: latest.ref };
  if (latest?.status === "rejected") return { allowed: false, status: "rejected", ref: latest.ref, created: false, note: latest.decision_note };
  const { approval, created } = await requestApproval(ws.sql, ws.id, {
    kind: req.kind,
    subjectType: req.subjectType,
    subjectId: req.subjectId,
    agent: req.agent,
    summary: req.summary,
    preview: req.preview ?? null,
    runId: req.runId ?? null,
  });
  if (created) {
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id, agent: req.agent, kind: "approval", runId: req.runId ?? null,
      message: `Asked for approval (${approval.ref}): ${req.summary}`, data: { ref: approval.ref, kind: req.kind },
    });
  }
  return { allowed: false, status: "pending", ref: approval.ref, created };
}

/** Plain-language progress in the activity stream. */
export async function activity(ws: WorkspaceContext, agent: AgentKey | Actor, message: string, data?: Record<string, unknown>, runId?: string | null): Promise<void> {
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: agent.startsWith("agent:") ? agent.slice(6) : agent,
    kind: "progress",
    message,
    runId: runId ?? null,
    data: data ?? null,
  });
}

/**
 * Queues a notification in the channel-agnostic outbox (`messages`); the notifier delivers it. Deduped per channel
 * on `dedupeKey`. Returns false when an identical message was already queued.
 */
export async function notify(ws: WorkspaceContext, msg: OutboundMessage): Promise<boolean> {
  const channel = ws.config.providers.notifier;
  const rows = await ws.sql`
    insert into messages (workspace_id, channel, direction, dedupe_key, ref, body, status)
    values (${ws.id}, ${channel}, 'out', ${msg.dedupeKey ?? null}, ${msg.ref ?? null}, ${ws.sql.json(msg as never)}, 'queued')
    on conflict do nothing
    returning id`;
  return rows.length > 0;
}

/** Reads a jsonb value from the `settings` table (workspace-level state such as cursors and locks). */
export async function getSetting<T>(ws: WorkspaceContext, key: string): Promise<T | undefined> {
  const rows = await ws.sql<{ value: T }[]>`select value from settings where workspace_id = ${ws.id} and key = ${key}`;
  return rows[0]?.value;
}

export async function setSetting(ws: WorkspaceContext, key: string, value: unknown): Promise<void> {
  await ws.sql`
    insert into settings (workspace_id, key, value, updated_at) values (${ws.id}, ${key}, ${ws.sql.json(value as never)}, now())
    on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()`;
}

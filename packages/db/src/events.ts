import type { Actor, Sql } from "@attentionos/core";

export type AgentEventKind = "progress" | "tool" | "text" | "error" | "handoff" | "cost" | "approval";

export type AgentEventInput = {
  workspaceId: string;
  /** agent key ("copywriter") or, for people and the system, the actor string ("user:local", "system"). */
  agent: string;
  kind: AgentEventKind;
  message: string;
  runId?: string | null;
  data?: Record<string, unknown> | null;
};

/** `agent:copywriter` → `copywriter`; anything else stays as written. */
export function agentColumn(actor: Actor | string): string {
  return actor.startsWith("agent:") ? actor.slice("agent:".length) : actor;
}

export async function recordAgentEvent(sql: Sql, e: AgentEventInput): Promise<void> {
  await sql`
    insert into agent_events (workspace_id, run_id, agent, kind, message, data)
    values (${e.workspaceId}, ${e.runId ?? null}, ${e.agent}, ${e.kind}, ${e.message}, ${e.data ? sql.json(e.data as never) : null})`;
}

export async function recordAgentEvents(sql: Sql, events: AgentEventInput[]): Promise<void> {
  if (!events.length) return;
  const rows = events.map((e) => ({
    workspace_id: e.workspaceId,
    run_id: e.runId ?? null,
    agent: e.agent,
    kind: e.kind,
    message: e.message,
    data: e.data ? sql.json(e.data as never) : null,
  }));
  await sql`insert into agent_events ${sql(rows, "workspace_id", "run_id", "agent", "kind", "message", "data")}`;
}

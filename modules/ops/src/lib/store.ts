import type { Actor, AgentKey, Sql, WorkspaceContext } from "@attentionos/core";
import { opsSettings, SETTING_KEYS } from "../settings.ts";
import { createMasker, maskPairs, type Masker } from "./mask.ts";
import type { QuietWindow } from "./quiet-hours.ts";

/**
 * Small repository helpers for the tables ops touches. Every query filters by workspace_id.
 */

type Json = Parameters<Sql["json"]>[0];
export const asJson = (sql: Sql, value: unknown) => sql.json(value as Json);

export async function getSetting<T>(ws: WorkspaceContext, key: string): Promise<T | undefined> {
  const rows = await ws.sql<{ value: T }[]>`select value from settings where workspace_id = ${ws.id} and key = ${key}`;
  return rows[0]?.value;
}

export async function setSetting(ws: WorkspaceContext, key: string, value: unknown): Promise<void> {
  await ws.sql`
    insert into settings (workspace_id, key, value, updated_at)
    values (${ws.id}, ${key}, ${asJson(ws.sql, value)}, now())
    on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()`;
}

export async function deleteSetting(ws: WorkspaceContext, key: string): Promise<void> {
  await ws.sql`delete from settings where workspace_id = ${ws.id} and key = ${key}`;
}

/** Demo mode: the chat/tool override wins over the config default. */
export async function isDemoMode(ws: WorkspaceContext): Promise<boolean> {
  const v = await getSetting<{ on?: boolean }>(ws, SETTING_KEYS.demoMode);
  return typeof v?.on === "boolean" ? v.on : opsSettings(ws.config).demoMode;
}

/** Quiet hours: the chat/tool override wins over `config.quietHours`. `{ off: true }` disables them. */
export async function quietWindow(ws: WorkspaceContext): Promise<QuietWindow | null> {
  const v = await getSetting<{ start?: string; end?: string; off?: boolean }>(ws, SETTING_KEYS.quietHours);
  if (v?.off) return null;
  if (v?.start && v.end) return { start: v.start, end: v.end };
  return ws.config.quietHours ?? null;
}

/** People whose names must not appear on camera in demo mode. */
export async function loadMasker(ws: WorkspaceContext): Promise<Masker> {
  if (!(await isDemoMode(ws))) return createMasker(false, []);
  const [contacts, triage, creators] = await Promise.all([
    ws.sql<{ name: string | null; email: string | null; handle: string | null; phone: string | null }[]>`
      select name, email::text as email, handle, phone from contacts where workspace_id = ${ws.id} order by updated_at desc limit 5000`,
    ws.sql<{ from_handle: string | null }[]>`
      select distinct from_handle from triage_items where workspace_id = ${ws.id} and from_handle is not null limit 5000`,
    ws.sql<{ handle: string }[]>`select handle from tracked_creators where workspace_id = ${ws.id} and tier <> 'own'`,
  ]);
  const pairs = maskPairs({
    names: contacts.map((c) => c.name).filter((x): x is string => !!x),
    emails: contacts.map((c) => c.email).filter((x): x is string => !!x),
    phones: contacts.map((c) => c.phone).filter((x): x is string => !!x),
    handles: [...contacts.map((c) => c.handle), ...triage.map((t) => t.from_handle), ...creators.map((c) => c.handle)].filter((x): x is string => !!x),
  });
  return createMasker(true, pairs);
}

export type EnqueueRun = {
  jobId: string;
  agent: AgentKey;
  input: Record<string, unknown>;
  trigger?: "schedule" | "manual" | "event" | "chat" | "webhook" | "handoff";
  dedupeKey?: string;
  createdBy: Actor;
  parentRunId?: string;
};

/** Queues an agent run. Returns null when an identical run (same dedupe key) is already queued or running. */
export async function enqueueRun(ws: WorkspaceContext, run: EnqueueRun): Promise<{ id: string } | null> {
  const rows = await ws.sql<{ id: string }[]>`
    insert into agent_runs (workspace_id, agent, job_id, trigger, input, dedupe_key, created_by, parent_run_id)
    values (${ws.id}, ${run.agent}, ${run.jobId}, ${run.trigger ?? "chat"}, ${asJson(ws.sql, run.input)},
            ${run.dedupeKey ?? null}, ${run.createdBy}, ${run.parentRunId ?? null})
    on conflict do nothing
    returning id`;
  return rows[0] ?? null;
}

export async function addEvent(
  sql: Sql,
  workspaceId: string,
  e: { agent: string; kind: "progress" | "tool" | "text" | "error" | "handoff" | "cost" | "approval"; message: string; runId?: string | null; data?: unknown },
): Promise<void> {
  await sql`
    insert into agent_events (workspace_id, run_id, agent, kind, message, data)
    values (${workspaceId}, ${e.runId ?? null}, ${e.agent}, ${e.kind}, ${e.message}, ${e.data === undefined ? null : asJson(sql, e.data)})`;
}

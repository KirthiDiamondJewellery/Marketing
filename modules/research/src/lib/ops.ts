import { jsonb, usdToMicro, microToUsd, type Actor, type AgentKey, type WorkspaceContext } from "@attentionos/core";
import { zonedParts } from "@attentionos/scoring";
import { num } from "./db.ts";

/**
 * Small write helpers shared by the research, strategy and learn modules: the notification outbox, the run
 * queue (hand-offs), the cost ledger and alert de-duplication. They only touch schema v1 tables.
 */

export type NotifyInput = {
  text: string;
  /** Same key is never queued twice (unique per workspace + channel). */
  dedupeKey?: string;
  priority?: "low" | "normal" | "high";
  ref?: string;
  format?: "plain" | "markdown";
  actions?: { id: string; label: string; style?: "primary" | "danger" | "default" }[];
};

/** Queues an outbound message on the workspace's notifier channel. Returns false when deduped. */
export async function queueNotification(ws: WorkspaceContext, msg: NotifyInput): Promise<boolean> {
  const channel = ws.config.providers.notifier;
  const body = {
    text: msg.text,
    format: msg.format ?? "plain",
    priority: msg.priority ?? "normal",
    ...(msg.dedupeKey ? { dedupeKey: msg.dedupeKey } : {}),
    ...(msg.ref ? { ref: msg.ref } : {}),
    ...(msg.actions ? { actions: msg.actions } : {}),
  };
  const rows = await ws.sql`
    insert into messages (workspace_id, channel, direction, dedupe_key, ref, body, status)
    values (${ws.id}, ${channel}, 'out', ${msg.dedupeKey ?? null}, ${msg.ref ?? null}, ${jsonb(ws.sql, body)}, 'queued')
    on conflict do nothing
    returning id`;
  return rows.length > 0;
}

/**
 * Alert with de-duplication through `alert_log`: the same key alerts at most once per `everyHours`.
 * Returns true when a message was queued.
 */
export async function alertOnce(ws: WorkspaceContext, key: string, text: string, opts: { everyHours?: number; priority?: NotifyInput["priority"] } = {}): Promise<boolean> {
  const everyHours = opts.everyHours ?? 24;
  const now = ws.now();
  const rows = await ws.sql`
    insert into alert_log (workspace_id, key, last_sent_at, count) values (${ws.id}, ${key}, ${now}, 1)
    on conflict (workspace_id, key) do update
      set last_sent_at = excluded.last_sent_at, count = alert_log.count + 1
      where alert_log.last_sent_at < ${new Date(now.getTime() - everyHours * 3_600_000)}
    returning count`;
  if (rows.length === 0) return false;
  return queueNotification(ws, { text, priority: opts.priority ?? "high", dedupeKey: `alert:${key}:${now.toISOString().slice(0, 13)}` });
}

export type EnqueueInput = {
  jobId: string;
  agent: AgentKey;
  input: unknown;
  trigger?: "schedule" | "manual" | "event" | "chat" | "webhook" | "handoff";
  dedupeKey?: string;
  parentRunId?: string | null;
  runAfter?: Date;
  createdBy?: Actor;
};

/** Queues a job run (hand-off). Returns the run id, or null when an identical run is already queued or running. */
export async function enqueueRun(ws: WorkspaceContext, r: EnqueueInput): Promise<string | null> {
  const rows = await ws.sql`
    insert into agent_runs (workspace_id, agent, job_id, trigger, status, input, dedupe_key, parent_run_id, run_after, created_by)
    values (${ws.id}, ${r.agent}, ${r.jobId}, ${r.trigger ?? "handoff"}, 'queued', ${jsonb(ws.sql, r.input ?? {})},
            ${r.dedupeKey ?? null}, ${r.parentRunId ?? null}, ${r.runAfter ?? ws.now()}, ${r.createdBy ?? "system"})
    on conflict do nothing
    returning id`;
  return (rows[0]?.id as string | undefined) ?? null;
}

export type CostCategory = "llm" | "scraping" | "publishing" | "images" | "asr" | "other";

export async function recordCost(ws: WorkspaceContext, c: { category: CostCategory; provider: string; usd: number; runId?: string | null; detail?: unknown }): Promise<void> {
  await ws.sql`
    insert into cost_ledger (workspace_id, ts, category, provider, amount_micro, run_id, detail)
    values (${ws.id}, ${ws.now()}, ${c.category}, ${c.provider}, ${usdToMicro(c.usd)}, ${c.runId ?? null}, ${c.detail === undefined ? null : jsonb(ws.sql, c.detail)})`;
}

/** Start of the current day or month in the workspace time zone, as a UTC instant. */
export function periodStart(now: Date, timeZone: string, period: "day" | "month"): Date {
  const p = zonedParts(now, timeZone);
  const day = period === "month" ? 1 : p.day;
  // Find the UTC instant whose local wall time is 00:00 on that date (two passes handle DST shifts).
  let guess = new Date(Date.UTC(p.year, p.month - 1, day, 0, 0, 0));
  for (let i = 0; i < 2; i++) {
    const g = zonedParts(guess, timeZone);
    const localAsUtc = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute);
    const target = Date.UTC(p.year, p.month - 1, day, 0);
    guess = new Date(guess.getTime() - (localAsUtc - target));
  }
  return guess;
}

export async function spendSince(ws: WorkspaceContext, category: CostCategory, since: Date): Promise<number> {
  const [row] = await ws.sql`
    select coalesce(sum(amount_micro), 0)::text as micro from cost_ledger
     where workspace_id = ${ws.id} and category = ${category} and ts >= ${since}`;
  return microToUsd(num(row?.micro) ?? 0);
}

export const fmtUsd = (usd: number) => `$${usd.toFixed(usd < 10 ? 2 : 0)}`;

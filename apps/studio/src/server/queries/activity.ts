import "server-only";
import { workspace } from "@/server/workspace";
import { toRunSummary, type RunSummary } from "./agents";

export type ActivityEvent = { id: number; ts: string; agent: string; runId: string | null; kind: string; message: string; data: unknown; jobId: string | null };

export const EVENT_KINDS = ["progress", "handoff", "approval", "error", "cost", "tool", "text"] as const;

export async function getActivity(filters: { agent?: string; kind?: string; before?: number; limit?: number } = {}): Promise<{ events: ActivityEvent[]; hasMore: boolean }> {
  const ws = workspace();
  const sql = ws.sql;
  const limit = Math.min(filters.limit ?? 80, 200);
  const agent = filters.agent && filters.agent !== "all" ? filters.agent : null;
  const kind = filters.kind && (EVENT_KINDS as readonly string[]).includes(filters.kind) ? filters.kind : null;
  const rows = await sql<{ id: string; ts: Date; agent: string; run_id: string | null; kind: string; message: string; data: unknown; job_id: string | null }[]>`
    select e.id, e.ts, e.agent, e.run_id, e.kind, e.message, e.data, r.job_id
      from agent_events e left join agent_runs r on r.id = e.run_id
     where e.workspace_id = ${ws.id}
       ${agent === "you" ? sql`and e.agent like 'user:%'` : agent ? sql`and e.agent = ${agent}` : sql``}
       ${kind ? sql`and e.kind = ${kind}` : sql``}
       ${filters.before ? sql`and e.id < ${filters.before}` : sql``}
     order by e.ts desc, e.id desc
     limit ${limit + 1}`;
  return {
    events: rows.slice(0, limit).map((r) => ({ id: Number(r.id), ts: r.ts.toISOString(), agent: r.agent, runId: r.run_id, kind: r.kind, message: r.message, data: r.data, jobId: r.job_id })),
    hasMore: rows.length > limit,
  };
}

export async function getRecentRuns(filters: { agent?: string; limit?: number } = {}): Promise<RunSummary[]> {
  const ws = workspace();
  const sql = ws.sql;
  const agent = filters.agent && filters.agent !== "all" && filters.agent !== "you" ? filters.agent : null;
  const rows = await sql<Parameters<typeof toRunSummary>[0][]>`
    select id, agent, job_id, trigger, status, output, error, cost_micro::text, turns, created_at, started_at, finished_at, created_by
      from agent_runs where workspace_id = ${ws.id} ${agent ? sql`and agent = ${agent}` : sql``}
     order by created_at desc limit ${Math.min(filters.limit ?? 30, 100)}`;
  return rows.map(toRunSummary);
}

export type RunDetail = RunSummary & {
  input: unknown;
  output: unknown;
  attempts: number;
  maxAttempts: number;
  parentRunId: string | null;
  events: ActivityEvent[];
  approvals: { id: string; ref: string; status: string; summary: string }[];
  ledger: { ts: string; category: string; provider: string; usd: number }[];
};

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const ws = workspace();
  const sql = ws.sql;
  const [run] = await sql<(Parameters<typeof toRunSummary>[0] & { input: unknown; attempts: number; max_attempts: number; parent_run_id: string | null })[]>`
    select id, agent, job_id, trigger, status, input, output, error, cost_micro::text, turns, created_at, started_at, finished_at, created_by,
           attempts, max_attempts, parent_run_id
      from agent_runs where id = ${runId} and workspace_id = ${ws.id}`;
  if (!run) return null;
  const [events, approvals, ledger] = await Promise.all([
    sql<{ id: string; ts: Date; agent: string; run_id: string | null; kind: string; message: string; data: unknown }[]>`
      select id, ts, agent, run_id, kind, message, data from agent_events where workspace_id = ${ws.id} and run_id = ${runId} order by id asc`,
    sql<{ id: string; ref: string; status: string; summary: string }[]>`
      select id, ref, status, summary from approvals where workspace_id = ${ws.id} and run_id = ${runId} order by requested_at`,
    sql<{ ts: Date; category: string; provider: string; amount_micro: string }[]>`
      select ts, category, provider, amount_micro::text from cost_ledger where workspace_id = ${ws.id} and run_id = ${runId} order by ts`,
  ]);
  return {
    ...toRunSummary(run),
    input: run.input,
    output: (run as unknown as { output: unknown }).output,
    attempts: run.attempts,
    maxAttempts: run.max_attempts,
    parentRunId: run.parent_run_id,
    events: events.map((e) => ({ id: Number(e.id), ts: e.ts.toISOString(), agent: e.agent, runId: e.run_id, kind: e.kind, message: e.message, data: e.data, jobId: run.job_id })),
    approvals,
    ledger: ledger.map((l) => ({ ts: l.ts.toISOString(), category: l.category, provider: l.provider, usd: Number(l.amount_micro) / 1_000_000 })),
  };
}

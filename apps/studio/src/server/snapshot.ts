import "server-only";
import { AGENT_KEYS, AGENT_MONOGRAMS, type AgentKey } from "@attentionos/core";
import type { StudioWorkspace } from "./workspace";
import { AGENT_ROLES, type AgentLive, type AgentState, type LiveEvent, type Snapshot } from "@/lib/live";

const NAMES: Record<AgentKey, string> = {
  chief_of_staff: "Chief of Staff",
  strategist: "Strategist",
  copywriter: "Copywriter",
  art_director: "Art Director",
  publisher: "Publisher",
  community: "Community",
  analyst: "Analyst",
};

type EventRow = { id: string | number; ts: Date; agent: string; run_id: string | null; kind: LiveEvent["kind"]; message: string; data: unknown };

/** "research.competitor-scan" → "Working on competitor scan" (never show raw job ids in the default view). */
export function jobLabel(jobId: string): string {
  const name = jobId.split(".").pop() ?? jobId;
  return `Working on ${name.replace(/-/g, " ")}`;
}

export function toLiveEvent(r: EventRow): LiveEvent {
  const data = (r.data ?? {}) as { to?: unknown };
  return {
    id: Number(r.id),
    ts: r.ts.toISOString(),
    agent: r.agent,
    runId: r.run_id,
    kind: r.kind,
    message: r.message,
    ...(typeof data.to === "string" ? { to: data.to } : {}),
  };
}

export async function eventsSince(ws: StudioWorkspace, afterId: number, limit = 100): Promise<LiveEvent[]> {
  const rows = await ws.sql<EventRow[]>`
    select id, ts, agent, run_id, kind, message, data from agent_events
    where workspace_id = ${ws.id} and id > ${afterId} order by id asc limit ${limit}`;
  return rows.map(toLiveEvent);
}

/** One consistent picture of the workspace for every Studio surface. */
export async function buildSnapshot(ws: StudioWorkspace): Promise<Snapshot> {
  const sql = ws.sql;
  const wsId = ws.id;

  const [wsRow] = await sql<{ name: string; timezone: string }[]>`select name, timezone from workspaces where id = ${wsId}`;
  const agentRows = await sql<{ key: string; name: string; monogram: string; autonomy: AgentLive["autonomy"]; enabled: boolean }[]>`
    select key, name, monogram, autonomy, enabled from agents where workspace_id = ${wsId}`;
  const running = await sql<{ id: string; agent: string; job_id: string; started_at: Date | null }[]>`
    select id, agent, job_id, started_at from agent_runs where workspace_id = ${wsId} and status = 'running' order by started_at desc`;
  const failedRecent = await sql<{ agent: string; error: string | null }[]>`
    select distinct on (agent) agent, error from agent_runs
    where workspace_id = ${wsId} and status = 'failed' and finished_at > now() - interval '1 hour'
    order by agent, finished_at desc`;
  const runs24 = await sql<{ agent: string; n: number; cost: string }[]>`
    select agent, count(*)::int as n, coalesce(sum(cost_micro), 0)::text as cost from agent_runs
    where workspace_id = ${wsId} and finished_at > now() - interval '24 hours' group by agent`;
  const approvals = await sql<{ id: string; ref: string; kind: string; agent: string; summary: string; requested_at: Date; preview: unknown }[]>`
    select id, ref, kind, agent, summary, requested_at, preview from approvals
    where workspace_id = ${wsId} and status = 'pending' order by requested_at asc limit 50`;
  const lastProgress = running.length
    ? await sql<{ run_id: string; message: string }[]>`
        select distinct on (run_id) run_id, message from agent_events
        where workspace_id = ${wsId} and run_id = any(${running.map((r) => r.id)}::uuid[]) and kind in ('progress', 'text')
        order by run_id, id desc`
    : [];
  const [queue] = await sql<{ queued: number; running: number; waiting: number; failed: number }[]>`
    select count(*) filter (where status = 'queued')::int as queued,
           count(*) filter (where status = 'running')::int as running,
           count(*) filter (where status = 'waiting_approval')::int as waiting,
           count(*) filter (where status = 'failed' and finished_at > now() - interval '24 hours')::int as failed
    from agent_runs where workspace_id = ${wsId}`;
  const [spend] = await sql<{ micro: string }[]>`
    select coalesce(sum(amount_micro), 0)::text as micro from cost_ledger
    where workspace_id = ${wsId} and category = 'llm' and ts >= date_trunc('day', now() at time zone ${ws.config.workspace.timezone}) at time zone ${ws.config.workspace.timezone}`;
  const posts = await sql<{ id: string; platform: string; status: string; at: Date | null; caption: string | null; title: string | null }[]>`
    select p.id, p.platform, p.status, coalesce(p.scheduled_at, p.published_at) as at, p.caption, c.title
    from posts p left join content c on c.id = p.content_id
    where p.workspace_id = ${wsId} and p.status in ('scheduled', 'assist', 'publishing', 'published', 'queued')
      and coalesce(p.scheduled_at, p.published_at, p.created_at) > now() - interval '2 days'
    order by coalesce(p.scheduled_at, p.published_at) asc nulls last limit 24`;
  const events = await sql<EventRow[]>`
    select id, ts, agent, run_id, kind, message, data from agent_events
    where workspace_id = ${wsId} order by id desc limit 60`;
  // The worker writes a heartbeat row every few seconds while it runs (apps/worker).
  const [worker] = await sql<{ alive: boolean }[]>`
    select exists (
      select 1 from settings
      where workspace_id = ${wsId} and key = 'worker:status' and updated_at > now() - interval '2 minutes'
        and coalesce((value->>'stopping')::boolean, false) = false
    ) as alive`;

  const byKey = new Map(agentRows.map((a) => [a.key, a]));
  const progressByRun = new Map(lastProgress.map((p) => [p.run_id, p.message]));
  const failedBy = new Map(failedRecent.map((f) => [f.agent, f.error]));
  const runsBy = new Map(runs24.map((r) => [r.agent, r]));

  const agents: AgentLive[] = AGENT_KEYS.map((key) => {
    const row = byKey.get(key);
    const run = running.find((r) => r.agent === key) ?? null;
    const pending = approvals.filter((a) => a.agent === key).length;
    const enabled = row?.enabled ?? true;
    let state: AgentState = "idle";
    let label = "Idle";
    if (!enabled) {
      state = "paused";
      label = "Paused by you";
    } else if (run) {
      state = "working";
      label = progressByRun.get(run.id) ?? jobLabel(run.job_id);
    } else if (pending) {
      state = "waiting";
      label = `${pending} ${pending === 1 ? "item needs" : "items need"} your approval`;
    } else if (failedBy.has(key)) {
      state = "blocked";
      label = failedBy.get(key) ?? "Last run failed";
    }
    const r24 = runsBy.get(key);
    return {
      key,
      name: row?.name ?? NAMES[key],
      monogram: row?.monogram ?? AGENT_MONOGRAMS[key],
      role: AGENT_ROLES[key],
      state,
      label,
      autonomy: row?.autonomy ?? "review_all",
      enabled,
      pendingApprovals: pending,
      run: run ? { id: run.id, jobId: run.job_id, startedAt: run.started_at?.toISOString() ?? null } : null,
      runs24h: r24?.n ?? 0,
      costTodayUsd: r24 ? Number(r24.cost) / 1_000_000 : 0,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    workspace: {
      id: wsId,
      name: wsRow?.name ?? ws.config.workspace.name,
      timezone: ws.config.workspace.timezone,
      mode: ws.config.mode,
    },
    agents,
    approvals: approvals.map((a) => ({ id: a.id, ref: a.ref, kind: a.kind, agent: a.agent, summary: a.summary, requestedAt: a.requested_at.toISOString(), preview: a.preview })),
    queue: { queued: queue?.queued ?? 0, running: queue?.running ?? 0, waitingApproval: queue?.waiting ?? 0, failed24h: queue?.failed ?? 0 },
    spend: { todayUsd: Number(spend?.micro ?? 0) / 1_000_000, dailyBudgetUsd: ws.config.budgets.dailyUsd },
    posts: posts.map((p) => ({ id: p.id, platform: p.platform, status: p.status, at: p.at?.toISOString() ?? null, caption: p.caption, title: p.title })),
    events: events.reverse().map(toLiveEvent),
    workerOnline: worker?.alive ?? false,
  };
}

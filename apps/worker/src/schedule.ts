import type { AgentKey, AttentionOSConfig, ModuleDefinition, WorkspaceContext } from "@attentionos/core";
import { enqueueRun } from "@attentionos/db";
import { CronError, latestFire, parseCron } from "./cron.ts";

export type ScheduleEntry = {
  jobId: string;
  cron: string;
  agent: AgentKey;
  moduleId: string;
  kind: "native" | "llm";
  source: "module" | "config";
};

const fullJobId = (moduleId: string, key: string) => (key.includes(".") ? key : `${moduleId}.${key}`);

/**
 * Schedules = module defaults (`module.json` schedules) overridden by `config.modules[id].schedules`.
 * An empty string turns a schedule off. Keys may be full job ids or short ones ("daily-brief").
 */
export function collectSchedules(modules: ModuleDefinition[], config: AttentionOSConfig): { entries: ScheduleEntry[]; problems: string[] } {
  const entries: ScheduleEntry[] = [];
  const problems: string[] = [];
  const tz = config.workspace.timezone;
  for (const m of modules) {
    const merged = new Map<string, { cron: string; source: ScheduleEntry["source"] }>();
    for (const [key, cron] of Object.entries(m.manifest.schedules)) merged.set(fullJobId(m.manifest.id, key), { cron, source: "module" });
    for (const [key, cron] of Object.entries(config.modules[m.manifest.id]?.schedules ?? {})) merged.set(fullJobId(m.manifest.id, key), { cron, source: "config" });
    for (const [jobId, { cron, source }] of merged) {
      if (!cron.trim()) continue;
      const job = m.jobs.find((j) => j.id === jobId);
      if (!job) {
        problems.push(`The ${m.manifest.name} schedule names a job that doesn't exist: ${jobId}.`);
        continue;
      }
      if (config.agents[job.agent]?.enabled === false) continue;
      try {
        parseCron(cron, tz);
      } catch (err) {
        problems.push(`${jobId}: ${err instanceof CronError ? err.message : String(err)}`);
        continue;
      }
      entries.push({ jobId, cron, agent: job.agent, moduleId: m.manifest.id, kind: job.kind, source });
    }
  }
  return { entries, problems };
}

const CURSOR_KEY = "worker:schedule_cursor";

export type SchedulerOptions = {
  ws: Pick<WorkspaceContext, "id" | "sql" | "config" | "log">;
  entries: ScheduleEntry[];
  /** Skip LLM schedules (Copilot mode or no API key). */
  skipLlm?: boolean;
  /** After downtime, run each schedule's most recent missed fire if it is newer than this. Default 1 hour. */
  catchUpMs?: number;
};

/**
 * Tick-based scheduler: each tick enqueues every schedule that fired since the previous tick, with a dedupe key per
 * fire time, so several workers or a restart never double-run a slot. The cursor lives in `settings`.
 */
export class Scheduler {
  private cursor: Date | null = null;
  private readonly catchUpMs: number;

  constructor(private readonly opts: SchedulerOptions) {
    this.catchUpMs = opts.catchUpMs ?? 60 * 60_000;
  }

  private async loadCursor(now: Date): Promise<Date> {
    const [row] = await this.opts.ws.sql<{ value: { at?: string } }[]>`
      select value from settings where workspace_id = ${this.opts.ws.id} and key = ${CURSOR_KEY}`;
    const saved = row?.value?.at ? new Date(row.value.at) : null;
    if (!saved || Number.isNaN(saved.getTime())) return now;
    return new Date(Math.max(saved.getTime(), now.getTime() - this.catchUpMs));
  }

  async tick(now: Date = new Date()): Promise<{ enqueued: string[]; skipped: string[] }> {
    const { ws, entries } = this.opts;
    const since = this.cursor ?? (await this.loadCursor(now));
    const enqueued: string[] = [];
    const skipped: string[] = [];
    for (const e of entries) {
      const fire = latestFire(e.cron, ws.config.workspace.timezone, since, now);
      if (!fire) continue;
      if (e.kind === "llm" && this.opts.skipLlm) {
        skipped.push(e.jobId);
        continue;
      }
      const res = await enqueueRun(ws.sql, {
        workspaceId: ws.id,
        jobId: e.jobId,
        agent: e.agent,
        trigger: "schedule",
        createdBy: "system",
        dedupeKey: `schedule:${e.jobId}:${fire.toISOString()}`,
        skipIfActive: true,
      });
      if (!res.deduped) enqueued.push(e.jobId);
    }
    this.cursor = now;
    await ws.sql`
      insert into settings (workspace_id, key, value) values (${ws.id}, ${CURSOR_KEY}, ${ws.sql.json({ at: now.toISOString() })})
      on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()`;
    return { enqueued, skipped };
  }
}

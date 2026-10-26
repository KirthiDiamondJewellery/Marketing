import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { JobDefinition, ModuleDefinition, WorkspaceContext } from "@attentionos/core";
import {
  cancelledRuns,
  claimRun,
  finishRun,
  heartbeatRuns,
  recoverStaleRuns,
  requeueInterrupted,
  retryRun,
  RUN_NOTIFY_CHANNEL,
  RUN_PRIORITY,
  withRunScope,
  type AgentRunRow,
  type ClaimFilter,
} from "@attentionos/db";
import { findJob, runJob, type LlmRunOptions, type RunResult } from "@attentionos/runner";
import { collectSchedules, Scheduler } from "./schedule.ts";
import { createWebhookServer } from "./webhooks.ts";

export type WorkerOptions = {
  ws: WorkspaceContext;
  modules: ModuleDefinition[];
  /** Runs at once in the shared slots. Default config runner.concurrency, else 2. */
  concurrency?: number;
  /** Extra slots only user-priority runs may use. Default config runner.userSlots, else 1. */
  userSlots?: number;
  /** Heavy jobs (renders) at once across all slots. Default config runner.maxHeavy, else `concurrency`. */
  maxHeavy?: number;
  /** Fallback queue check; new runs are normally claimed at once through LISTEN/NOTIFY. Default 2 s. */
  pollMs?: number;
  /** Claim new runs the moment they're queued (Postgres LISTEN). Default: on unless `manual`. */
  listen?: boolean;
  heartbeatMs?: number;
  /** A running run without a heartbeat for this long is recovered. Default 300 s. */
  staleAfterSeconds?: number;
  scheduleEveryMs?: number;
  /** Port for webhooks; null turns the receiver off. Default ATTENTIONOS_WEBHOOK_PORT or 8787. */
  webhookPort?: number | null;
  webhookHost?: string;
  /** How long shutdown waits for running jobs before putting them back on the queue. Default 30 s. */
  shutdownGraceMs?: number;
  /** Injected job runner (tests). */
  runJob?: (ws: WorkspaceContext, job: JobDefinition, input: unknown, opts: LlmRunOptions) => Promise<RunResult>;
  /** Don't start timers; drive with `tick()` (tests). */
  manual?: boolean;
};

export type WorkerHandle = {
  id: string;
  webhookUrl?: string;
  /** One scheduling + claiming pass. */
  tick(): Promise<void>;
  /** Resolves when every run started so far has finished. */
  idle(): Promise<void>;
  active(): string[];
  stop(reason?: string): Promise<void>;
};

type Active = { run: AgentRunRow; controller: AbortController; done: Promise<void>; lane: Lane; heavy: boolean };

/**
 * Slots: `concurrency` shared slots take any run, highest priority first; `userSlots` more take only runs someone is
 * waiting on (priority >= user), so a chat message or an upload starts at once even while long background jobs fill
 * the shared slots. Heavy jobs (renders, transcription) are capped at `maxHeavy` across all slots.
 */
export type Lane = "shared" | "user";
export type LaneConfig = { concurrency: number; userSlots: number; maxHeavy: number; userPriority: number };

/** Which slot the next claim fills and what it may take, or null when every slot is busy. */
export function nextClaim(active: { lane: Lane; heavy: boolean }[], cfg: LaneConfig, heavyJobs: string[]): { lane: Lane; filter: ClaimFilter } | null {
  const shared = active.filter((a) => a.lane === "shared").length;
  const user = active.length - shared;
  const lane: Lane | null = shared < cfg.concurrency ? "shared" : user < cfg.userSlots ? "user" : null;
  if (!lane) return null;
  const heavyFull = heavyJobs.length > 0 && active.filter((a) => a.heavy).length >= cfg.maxHeavy;
  return {
    lane,
    filter: {
      ...(lane === "user" ? { minPriority: cfg.userPriority } : {}),
      ...(heavyFull ? { excludeJobs: heavyJobs } : {}),
    },
  };
}

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const { ws, modules } = opts;
  const id = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const runner = ws.config.runner;
  const concurrency = Math.max(1, opts.concurrency ?? runner.concurrency ?? 2);
  const lanes: LaneConfig = {
    concurrency,
    userSlots: Math.max(0, opts.userSlots ?? runner.userSlots ?? 1),
    maxHeavy: Math.max(1, opts.maxHeavy ?? runner.maxHeavy ?? concurrency),
    userPriority: RUN_PRIORITY.user,
  };
  const heavyJobs = modules.flatMap((m) => m.jobs.filter((j) => j.heavy).map((j) => j.id));
  const execute = opts.runJob ?? runJob;
  const active = new Map<string, Active>();
  const timers: NodeJS.Timeout[] = [];
  const wakeTimers = new Map<number, NodeJS.Timeout>();
  let stopping = false;

  const engineReady = ws.config.runner.engine === "claude-code" || Boolean(ws.secret("ANTHROPIC_API_KEY"));
  const skipLlm = ws.config.mode !== "autopilot" || !engineReady;
  const { entries, problems } = collectSchedules(modules, ws.config);
  for (const p of problems) ws.log.warn(p);
  if (skipLlm && entries.some((e) => e.kind === "llm")) {
    ws.log.warn(
      ws.config.mode !== "autopilot"
        ? "AI jobs run when you ask for them. To also run them on a schedule, set mode: \"autopilot\" (Studio → Settings)."
        : "The API engine has no ANTHROPIC_API_KEY, so scheduled AI jobs are skipped. Data jobs still run.",
    );
  }
  const scheduler = new Scheduler({ ws, entries, skipLlm });

  const runOne = async (run: AgentRunRow, controller: AbortController) => {
    const log = ws.log.child({ run: run.id, job: run.job_id });
    const job = findJob(modules, run.job_id);
    if (!job) {
      await finishRun(ws.sql, run.id, { status: "failed", error: `The job ${run.job_id} isn't installed or its module is turned off.` });
      return;
    }
    const automatic = run.trigger === "schedule" || run.trigger === "event" || run.trigger === "webhook";
    if (automatic && ws.config.agents[job.agent]?.enabled === false) {
      await finishRun(ws.sql, run.id, { status: "cancelled", error: "This agent is turned off." });
      return;
    }
    try {
      // Runs this job queues (hand-offs, pipeline steps) become its follow-ups and inherit its priority.
      const result = await withRunScope(run.id, () => execute(ws, job, run.input, { runId: run.id, signal: controller.signal, modules, trigger: run.trigger }));
      if (result.status === "failed" && result.retryAfterMs !== undefined && (await retryRun(ws.sql, ws.id, run.id, result.retryAfterMs / 1000))) {
        log.info("will retry", { inSeconds: Math.round(result.retryAfterMs / 1000) });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fix = (err as { fix?: string }).fix;
      await finishRun(ws.sql, run.id, { status: "failed", error: fix ? `${message} ${fix}` : message });
    }
  };

  const claimLoop = async () => {
    while (!stopping) {
      const next = nextClaim([...active.values()], lanes, heavyJobs);
      if (!next) break;
      const run = await claimRun(ws.sql, ws.id, id, undefined, next.filter);
      if (!run) break;
      const controller = new AbortController();
      const entry: Active = { run, controller, done: Promise.resolve(), lane: next.lane, heavy: heavyJobs.includes(run.job_id) };
      entry.done = runOne(run, controller)
        .catch((err: unknown) => ws.log.error("run crashed", { run: run.id, error: (err as Error).message }))
        .finally(() => {
          active.delete(run.id);
          // A slot just freed up: take the next run now rather than on the next poll.
          void wake();
        });
      active.set(run.id, entry);
    }
  };

  // One claim pass at a time; a wake-up that arrives mid-pass runs another pass right after.
  let claiming: Promise<void> | undefined;
  let again = false;
  const wake = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (claiming) {
      again = true;
      return claiming;
    }
    claiming = (async () => {
      do {
        again = false;
        try {
          await claimLoop();
        } catch (err) {
          ws.log.warn("worker claim failed", { error: (err as Error).message });
        }
      } while (again && !stopping);
    })().finally(() => {
      claiming = undefined;
    });
    return claiming;
  };

  /** NOTIFY from the queue: claim now, or when a delayed run comes due. */
  const onNotify = (payload: string) => {
    let note: { ws?: string; inMs?: number };
    try {
      note = JSON.parse(payload) as typeof note;
    } catch {
      return;
    }
    if (note.ws !== ws.id || stopping) return;
    const inMs = Number(note.inMs) || 0;
    if (inMs <= 20) {
      void wake();
      return;
    }
    if (inMs > 15 * 60_000) return; // the poll picks it up
    const due = Math.ceil((Date.now() + inMs) / 100) * 100;
    if (wakeTimers.has(due)) return;
    const t = setTimeout(() => {
      wakeTimers.delete(due);
      void wake();
    }, due - Date.now() + 20);
    t.unref?.();
    wakeTimers.set(due, t);
  };

  let ticking = false;
  const tick = async () => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      await scheduler.tick(new Date());
    } catch (err) {
      ws.log.warn("worker tick failed", { error: (err as Error).message });
    } finally {
      ticking = false;
    }
    await wake();
  };

  const heartbeat = async () => {
    const ids = [...active.keys()];
    await heartbeatRuns(ws.sql, ids, id).catch(() => {});
    for (const cancelled of await cancelledRuns(ws.sql, ids).catch(() => [] as string[])) active.get(cancelled)?.controller.abort();
    await ws.sql`
      insert into settings (workspace_id, key, value)
      values (${ws.id}, 'worker:status', ${ws.sql.json({ workerId: id, pid: process.pid, at: new Date().toISOString(), running: ids.length, stopping })})
      on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()`.catch(() => {});
  };

  const recover = async () => {
    const n = await recoverStaleRuns(ws.sql, opts.staleAfterSeconds ?? 300).catch(() => 0);
    if (n) ws.log.info("put stalled runs back on the queue", { count: n });
  };

  let webhook: Awaited<ReturnType<typeof createWebhookServer>> | undefined;
  const port = opts.webhookPort === undefined ? Number(ws.secret("ATTENTIONOS_WEBHOOK_PORT") ?? 8787) : opts.webhookPort;
  if (port !== null && Number.isFinite(port)) {
    webhook = await createWebhookServer({ ws, modules, port, host: opts.webhookHost });
  }

  await recover();
  let listener: { unlisten(): Promise<void> } | undefined;
  if (opts.listen ?? !opts.manual) {
    // On every (re)connect, also check the queue for anything queued while the listener was down.
    listener = await ws.sql.listen(RUN_NOTIFY_CHANNEL, onNotify, () => void wake()).catch((err: unknown) => {
      ws.log.warn("Instant pickup is off, so new work is checked every few seconds.", { error: (err as Error).message });
      return undefined;
    });
  }
  if (!opts.manual) {
    timers.push(setInterval(() => void tick(), opts.pollMs ?? 2_000));
    timers.push(setInterval(() => void heartbeat(), opts.heartbeatMs ?? 15_000));
    timers.push(setInterval(() => void recover(), 60_000));
    void tick();
    void heartbeat();
  }

  return {
    id,
    webhookUrl: webhook?.url,
    tick,
    active: () => [...active.keys()],
    idle: async () => {
      while (active.size || claiming) {
        await claiming;
        await Promise.all([...active.values()].map((a) => a.done));
      }
    },
    async stop(reason = "stopping") {
      if (stopping) return;
      stopping = true;
      ws.log.info("worker stopping", { reason, running: active.size });
      for (const t of timers) clearInterval(t);
      for (const t of wakeTimers.values()) clearTimeout(t);
      await listener?.unlisten().catch(() => {});
      await webhook?.close();
      const grace = opts.shutdownGraceMs ?? 30_000;
      const settled = Promise.all([...active.values()].map((a) => a.done));
      const timedOut = await Promise.race([settled.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), grace).unref())]);
      if (timedOut) {
        const interrupted = [...active.values()];
        for (const a of interrupted) a.controller.abort();
        await Promise.all(interrupted.map((a) => a.done));
        await requeueInterrupted(ws.sql, ws.id, interrupted.map((a) => a.run.id));
      }
      await heartbeat();
    },
  };
}

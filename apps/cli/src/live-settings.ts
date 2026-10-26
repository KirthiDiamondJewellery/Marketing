import { createHash } from "node:crypto";
import { readFileSync, statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Live settings for `attentionos up` / `attentionos studio`: watch the workspace's config file and .env, and when
 * either really changes, re-load the workspace and restart the worker and the Studio server with it, so a save in
 * Studio (Settings, setup) applies without a manual restart.
 */

// ───────────────────────────── Watching ─────────────────────────────

/** sha256 of a file's bytes, or "missing". */
export function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}

function statSignature(path: string): string {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export type WatchSettingsOptions = {
  files: string[];
  /** Called once per settled burst of real changes (content hash differs from the last one seen). */
  onChange(changed: string[]): Promise<void> | void;
  /** Quiet time after the last event before checking. Default 1.5 s. */
  debounceMs?: number;
  /**
   * Polling interval (stat checks), the fallback for file systems that don't deliver fs.watch events, such as some
   * Docker bind mounts edited from the host. Default 2 s; 0 turns polling off.
   */
  pollMs?: number;
  /** fs.watch, injectable for tests; false = polling only. */
  watch?: typeof fsWatch | false;
  onError?(err: unknown): void;
};

export type SettingsWatcher = {
  /** Something may have changed: check after the debounce. */
  trigger(): void;
  /** Check now (skips the debounce). Resolves when any resulting onChange has finished. */
  check(): Promise<void>;
  close(): void;
};

export function watchSettings(opts: WatchSettingsOptions): SettingsWatcher {
  const debounceMs = opts.debounceMs ?? 1500;
  const pollMs = opts.pollMs ?? 2000;
  const hashes = new Map(opts.files.map((f) => [f, hashFile(f)]));
  const signatures = new Map(opts.files.map((f) => [f, statSignature(f)]));
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let closed = false;

  const trigger = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check(), debounceMs);
    timer.unref?.();
  };

  const check = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      // A change landed while the last one was being applied: look again once it's done.
      again = true;
      return running;
    }
    const changed = opts.files.filter((f) => {
      const h = hashFile(f);
      if (h === hashes.get(f)) return false;
      hashes.set(f, h);
      return true;
    });
    if (!changed.length) return;
    running = (async () => {
      try {
        await opts.onChange(changed);
      } catch (err) {
        opts.onError?.(err);
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
    if (again) {
      again = false;
      trigger();
    }
  };

  // Watch the folders, not the files: Studio saves by writing a temp file and renaming it over the original, which
  // ends a watch on the file itself.
  const watchFn = opts.watch === undefined ? fsWatch : opts.watch;
  if (watchFn) {
    const byDir = new Map<string, Set<string>>();
    for (const f of opts.files) byDir.set(dirname(f), (byDir.get(dirname(f)) ?? new Set()).add(basename(f)));
    for (const [dir, names] of byDir) {
      try {
        const w = watchFn(dir, { persistent: false }, (_event, filename) => {
          if (!filename || names.has(basename(String(filename)))) trigger();
        });
        w.on("error", () => w.close());
        watchers.push(w);
      } catch {
        // No fs.watch here (or the folder is missing): polling covers it.
      }
    }
  }
  if (pollMs > 0) {
    poller = setInterval(() => {
      for (const f of opts.files) {
        const sig = statSignature(f);
        if (sig !== signatures.get(f)) {
          signatures.set(f, sig);
          trigger();
        }
      }
    }, pollMs);
    poller.unref?.();
  }

  return {
    trigger,
    check,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poller);
      for (const w of watchers) w.close();
    },
  };
}

// ───────────────────────────── Applying ─────────────────────────────

export type WorkerLike = { stop(reason?: string): Promise<void> };

/** What's running: the loaded workspace, the worker started from it (if any) and the env Studio was started with. */
export type LiveState<W> = { ws: W; worker?: WorkerLike; studioEnv: Record<string, string> };

export type ReloadEvent =
  | { kind: "applying"; changed: string[] }
  | { kind: "applied"; studioRestarted: boolean; workerRestarted: boolean }
  | { kind: "invalid"; message: string; fix?: string }
  | { kind: "failed"; message: string; fix?: string }
  | { kind: "aborted" };

export type ReloadOutcome = "applied" | "invalid" | "failed" | "aborted";

export type ReloadDeps<W extends { close(): Promise<void> }> = {
  /** Loads and validates the workspace again (config, .env, database, providers, modules). Throws when it's not usable. */
  load(): Promise<{ ws: W; studioEnv: Record<string, string> }>;
  /** A reason when the new workspace must not replace the current one (e.g. it's a different workspace); else null. */
  refuse?(current: W, next: W): { message: string; fix?: string } | null;
  /** Starts a worker; leave out when this process runs no worker. */
  startWorker?(ws: W): Promise<WorkerLike>;
  /** Stops the running Studio, waits for it to exit, then starts it with this env and waits until it answers. */
  restartStudio(env: Record<string, string>): Promise<void>;
  /** True once the process is shutting down: stop half way and start nothing new. */
  stopping(): boolean;
  report(event: ReloadEvent): void;
};

function describe(err: unknown): { message: string; fix?: string } {
  const e = err as { message?: string; fix?: string; hint?: string };
  return { message: e?.message ?? String(err), fix: e?.fix ?? e?.hint };
}

/**
 * Applies new settings: load them (invalid → keep running the old ones), then in parallel stop the worker (it stops
 * claiming and lets running jobs finish, up to its grace period) and restart Studio when its env changed, then start
 * a fresh worker. The old workspace is closed only once the new one is running.
 */
export function createReloader<W extends { close(): Promise<void> }>(initial: LiveState<W>, deps: ReloadDeps<W>) {
  let state = initial;
  let chain: Promise<unknown> = Promise.resolve();

  const reloadOnce = async (changed: string[]): Promise<ReloadOutcome> => {
    if (deps.stopping()) return "aborted";
    deps.report({ kind: "applying", changed });
    let next: { ws: W; studioEnv: Record<string, string> };
    try {
      next = await deps.load();
    } catch (err) {
      deps.report({ kind: "invalid", ...describe(err) });
      return "invalid";
    }
    const refusal = deps.refuse?.(state.ws, next.ws);
    if (refusal) {
      await next.ws.close().catch(() => {});
      deps.report({ kind: "invalid", ...refusal });
      return "invalid";
    }

    const old = state;
    const studioChanged = !isDeepStrictEqual(next.studioEnv, old.studioEnv);
    let studioError: unknown;
    await Promise.all([
      old.worker?.stop("settings changed") ?? Promise.resolve(),
      studioChanged ? deps.restartStudio(next.studioEnv).catch((err: unknown) => (studioError = err ?? new Error("Studio didn't start."))) : Promise.resolve(),
    ]);

    if (deps.stopping()) {
      state = { ...old, worker: undefined };
      await next.ws.close().catch(() => {});
      deps.report({ kind: "aborted" });
      return "aborted";
    }

    if (studioError) {
      // Put things back as they were.
      const problem = describe(studioError);
      let worker: WorkerLike | undefined;
      try {
        await deps.restartStudio(old.studioEnv);
        if (deps.startWorker) worker = await deps.startWorker(old.ws);
      } catch (err) {
        state = { ...old, worker };
        await next.ws.close().catch(() => {});
        throw err;
      }
      state = { ...old, worker };
      await next.ws.close().catch(() => {});
      deps.report({ kind: "failed", message: `Studio didn't start with your new settings: ${problem.message}`, fix: problem.fix });
      return "failed";
    }

    let worker: WorkerLike | undefined;
    if (deps.startWorker) {
      try {
        worker = await deps.startWorker(next.ws);
      } catch (err) {
        const problem = describe(err);
        let fallback: WorkerLike | undefined;
        try {
          fallback = await deps.startWorker(old.ws);
        } catch {
          // reported below
        }
        state = { ...old, worker: fallback, studioEnv: studioChanged ? next.studioEnv : old.studioEnv };
        await next.ws.close().catch(() => {});
        deps.report({
          kind: "failed",
          message: `The worker didn't start with your new settings, so it ${fallback ? "kept the previous ones" : "is stopped"}: ${problem.message}`,
          fix: problem.fix,
        });
        return "failed";
      }
    }

    state = { ws: next.ws, worker, studioEnv: next.studioEnv };
    await old.ws.close().catch(() => {});
    deps.report({ kind: "applied", studioRestarted: studioChanged, workerRestarted: Boolean(worker) });
    return "applied";
  };

  return {
    state: () => state,
    /** Reloads run one at a time, in order. */
    reload(changed: string[]): Promise<ReloadOutcome> {
      const run = chain.then(() => reloadOnce(changed));
      chain = run.catch(() => {});
      return run;
    },
    /** Resolves when no reload is in flight. */
    settled: () => chain.then(() => {}),
  };
}

import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReloader, hashFile, watchSettings, type ReloadEvent, type WorkerLike } from "../src/live-settings.ts";

function workspaceFiles() {
  const root = mkdtempSync(join(tmpdir(), "aos-live-"));
  const config = join(root, "attentionos.config.ts");
  const env = join(root, ".env");
  writeFileSync(config, "export default { mode: 'copilot' };\n");
  writeFileSync(env, "DATABASE_URL=postgres://x\n");
  return { root, config, env };
}

describe("watching the settings files", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the burst to settle, then reports each changed file once", async () => {
    const { config, env } = workspaceFiles();
    const onChange = vi.fn();
    const w = watchSettings({ files: [config, env], onChange, debounceMs: 1500, pollMs: 0, watch: false });
    writeFileSync(config, "export default { mode: 'autopilot' };\n");
    for (let i = 0; i < 5; i++) {
      w.trigger();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([config]);
    w.close();
  });

  it("ignores saves that don't change the content (same hash)", async () => {
    const { config, env } = workspaceFiles();
    const onChange = vi.fn();
    const w = watchSettings({ files: [config, env], onChange, debounceMs: 100, pollMs: 0, watch: false });
    const before = hashFile(env);
    // Studio saves by writing a temp file and renaming it over the original: same bytes, new inode and mtime.
    writeFileSync(`${env}.tmp`, "DATABASE_URL=postgres://x\n");
    renameSync(`${env}.tmp`, env);
    expect(hashFile(env)).toBe(before);
    w.trigger();
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).not.toHaveBeenCalled();

    writeFileSync(env, "DATABASE_URL=postgres://x\nZERNIO_API_KEY=abc12345\n");
    w.trigger();
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledWith([env]);
    w.close();
  });

  it("notices changes by polling when no watch events arrive", async () => {
    const { config, env } = workspaceFiles();
    const onChange = vi.fn();
    const w = watchSettings({ files: [config, env], onChange, debounceMs: 100, pollMs: 1000, watch: false });
    writeFileSync(config, "export default { mode: 'autopilot', budgets: {} };\n");
    await vi.advanceTimersByTimeAsync(1200);
    expect(onChange).toHaveBeenCalledWith([config]);
    w.close();
  });

  it("checks again after a change that landed while the last one was being applied", async () => {
    const { config, env } = workspaceFiles();
    let release!: () => void;
    const calls: string[][] = [];
    const onChange = vi.fn((changed: string[]) => {
      calls.push(changed);
      if (calls.length === 1) return new Promise<void>((r) => (release = r));
    });
    const w = watchSettings({ files: [config, env], onChange, debounceMs: 100, pollMs: 0, watch: false });
    writeFileSync(config, "export default { mode: 'autopilot' };\n");
    w.trigger();
    await vi.advanceTimersByTimeAsync(150);
    writeFileSync(env, "DATABASE_URL=postgres://y\n");
    w.trigger();
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toEqual([[config]]);
    release();
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toEqual([[config], [env]]);
    w.close();
  });
});

// ───────────────────────────── Restarting ─────────────────────────────

type FakeWs = { name: string; closed: boolean; close(): Promise<void> };
const fakeWs = (name: string): FakeWs => ({
  name,
  closed: false,
  async close() {
    this.closed = true;
  },
});

function harness(opts: { loadFails?: boolean; studioFailsWith?: string; workerFailsFor?: string; stopWhileStopping?: string } = {}) {
  const log: string[] = [];
  const events: ReloadEvent[] = [];
  const oldWs = fakeWs("old");
  const newWs = fakeWs("new");
  let stopping = false;
  const worker = (name: string): WorkerLike => ({
    async stop(reason) {
      log.push(`worker ${name} stop (${reason})`);
      if (opts.stopWhileStopping === name) stopping = true; // Ctrl-C while this worker is finishing its jobs
      await new Promise((r) => setTimeout(r, 20)); // running jobs finishing
      log.push(`worker ${name} stopped`);
    },
  });
  const reloader = createReloader<FakeWs>(
    { ws: oldWs, worker: worker("old"), studioEnv: { CONFIG: "old" } },
    {
      load: async () => {
        log.push("load");
        if (opts.loadFails) throw Object.assign(new Error("Your config has problems: mode: invalid option"), { fix: "Edit config/attentionos.config.ts." });
        return { ws: newWs, studioEnv: { CONFIG: "new" } };
      },
      startWorker: async (ws) => {
        log.push(`worker ${ws.name} start`);
        if (opts.workerFailsFor === ws.name) throw new Error("port 8787 in use");
        return worker(ws.name);
      },
      restartStudio: async (env) => {
        log.push(`studio stop`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`studio start ${env.CONFIG}`);
        if (opts.studioFailsWith === env.CONFIG) throw new Error("it crashed");
        log.push(`studio healthy ${env.CONFIG}`);
      },
      stopping: () => stopping,
      report: (e) => events.push(e),
    },
  );
  return { reloader, log, events, oldWs, newWs, stop: () => (stopping = true) };
}

describe("applying new settings", () => {
  it("restarts Studio while the worker drains, then starts a fresh worker and closes the old workspace", async () => {
    const h = harness();
    expect(await h.reloader.reload(["/ws/config/attentionos.config.ts"])).toBe("applied");
    expect(h.log[0]).toBe("load");
    // Studio is back before the old worker has finished its jobs, and the new worker starts only after that.
    expect(h.log.indexOf("studio healthy new")).toBeLessThan(h.log.indexOf("worker old stopped"));
    expect(h.log.indexOf("worker old stopped")).toBeLessThan(h.log.indexOf("worker new start"));
    expect(h.log.at(-1)).toBe("worker new start");
    expect(h.oldWs.closed).toBe(true);
    expect(h.newWs.closed).toBe(false);
    expect(h.reloader.state().ws).toBe(h.newWs);
    expect(h.events.map((e) => e.kind)).toEqual(["applying", "applied"]);
    expect(h.events[1]).toMatchObject({ studioRestarted: true, workerRestarted: true });
  });

  it("keeps the old settings running when the new ones don't load", async () => {
    const h = harness({ loadFails: true });
    expect(await h.reloader.reload(["/ws/.env"])).toBe("invalid");
    expect(h.log).toEqual(["load"]);
    expect(h.reloader.state().ws).toBe(h.oldWs);
    expect(h.oldWs.closed).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ kind: "invalid", message: expect.stringContaining("mode"), fix: expect.stringContaining("config") });
  });

  it("refuses a workspace that isn't the one running", async () => {
    const h = harness();
    const r = createReloader<FakeWs>(
      { ws: h.oldWs, studioEnv: {} },
      {
        load: async () => ({ ws: h.newWs, studioEnv: {} }),
        refuse: () => ({ message: "Your settings now point at a different workspace." }),
        restartStudio: async () => {
          throw new Error("should not restart");
        },
        stopping: () => false,
        report: (e) => h.events.push(e),
      },
    );
    expect(await r.reload(["x"])).toBe("invalid");
    expect(h.newWs.closed).toBe(true);
    expect(h.oldWs.closed).toBe(false);
  });

  it("doesn't restart Studio when its env is unchanged (a key only the worker uses)", async () => {
    const h = harness();
    const restartStudio = vi.fn(async () => {});
    const r = createReloader<FakeWs>(
      { ws: h.oldWs, worker: { stop: async () => void h.log.push("worker old stopped") }, studioEnv: { CONFIG: "same" } },
      {
        load: async () => ({ ws: h.newWs, studioEnv: { CONFIG: "same" } }),
        startWorker: async () => ({ stop: async () => {} }),
        restartStudio,
        stopping: () => false,
        report: (e) => h.events.push(e),
      },
    );
    expect(await r.reload(["/ws/.env"])).toBe("applied");
    expect(restartStudio).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ kind: "applied", studioRestarted: false, workerRestarted: true });
  });

  it("puts the previous Studio and worker back when Studio won't start with the new settings", async () => {
    const h = harness({ studioFailsWith: "new" });
    expect(await h.reloader.reload(["/ws/config/attentionos.config.ts"])).toBe("failed");
    expect(h.log).toContain("studio healthy old");
    expect(h.log.at(-1)).toBe("worker old start");
    expect(h.reloader.state().ws).toBe(h.oldWs);
    expect(h.newWs.closed).toBe(true);
    expect(h.oldWs.closed).toBe(false);
  });

  it("falls back to the previous worker when the new one won't start", async () => {
    const h = harness({ workerFailsFor: "new" });
    expect(await h.reloader.reload(["/ws/.env"])).toBe("failed");
    expect(h.log.slice(-2)).toEqual(["worker new start", "worker old start"]);
    expect(h.reloader.state().ws).toBe(h.oldWs);
    expect(h.events.at(-1)).toMatchObject({ kind: "failed", message: expect.stringContaining("kept the previous ones") });
  });

  it("starts nothing new once AttentionOS is stopping", async () => {
    const h = harness({ stopWhileStopping: "old" }); // Ctrl-C while the old worker is finishing its jobs
    expect(await h.reloader.reload(["/ws/.env"])).toBe("aborted");
    expect(h.log).toContain("worker old stopped");
    expect(h.log).not.toContain("worker new start");
    expect(h.newWs.closed).toBe(true);
  });

  it("runs reloads one at a time", async () => {
    const h = harness();
    await Promise.all([h.reloader.reload(["a"]), h.reloader.reload(["b"])]);
    expect(h.log.filter((l) => l === "load")).toHaveLength(2);
    expect(h.log.indexOf("worker new start")).toBeLessThan(h.log.lastIndexOf("load"));
  });
});

import "server-only";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StudioSetupError, workspace, type StudioWorkspace } from "./workspace";

/**
 * Health and doctor for Studio.
 *
 * The full doctor is the CLI's own (`attentionos doctor`): Studio runs it as a child process and reads its checklist,
 * so the checks and the plain-language fixes are exactly what the terminal shows. The CLI tells Studio how to call it
 * (ATTENTIONOS_CLI); from source Studio finds apps/cli itself. If neither works, Studio runs a short in-process
 * subset (database, worker, ffmpeg, uv, Claude Code).
 */

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type DoctorCheck = { status: CheckStatus; label: string; detail?: string; fix?: string };
export type DoctorSection = { title: string; checks: DoctorCheck[] };
export type DoctorReport = { source: "cli" | "studio"; ranAt: string; sections: DoctorSection[]; summary: string; failed: number; warned: number };

export function studioVersion(): string {
  if (process.env.ATTENTIONOS_VERSION) return process.env.ATTENTIONOS_VERSION;
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(timer));
}

export type WorkerState = { online: boolean; lastSeen: string | null; running: number };

/** The worker writes `worker:status` every 15 s; online = seen in the last minute and not shutting down. */
export async function workerState(ws: StudioWorkspace): Promise<WorkerState> {
  const [row] = await ws.sql<{ value: { at?: string; running?: number; stopping?: boolean }; updated_at: Date; fresh: boolean }[]>`
    select value, updated_at, updated_at > now() - interval '60 seconds' as fresh
    from settings where workspace_id = ${ws.id} and key = 'worker:status'`;
  if (!row) return { online: false, lastSeen: null, running: 0 };
  return { online: row.fresh && !row.value?.stopping, lastSeen: row.updated_at.toISOString(), running: Number(row.value?.running ?? 0) };
}

export type Health = { ok: boolean; workspace: string | null; worker: "online" | "offline"; version: string; problem?: string };

export async function studioHealth(): Promise<Health> {
  const version = studioVersion();
  let ws: StudioWorkspace;
  try {
    ws = workspace();
  } catch (err) {
    return { ok: false, workspace: null, worker: "offline", version, problem: err instanceof StudioSetupError ? "Studio was started without a workspace." : "Studio couldn't load its workspace." };
  }
  const result = await withTimeout(
    workerState(ws).then(
      (w) => ({ db: true, worker: w.online }),
      () => ({ db: false, worker: false }),
    ),
    4000,
    { db: false, worker: false },
  );
  return {
    ok: result.db,
    workspace: ws.config.workspace.name,
    worker: result.worker ? "online" : "offline",
    version,
    ...(result.db ? {} : { problem: "Can't reach the database." }),
  };
}

// ───────────────────────────── Doctor via the CLI ─────────────────────────────

/** How to run the CLI: from ATTENTIONOS_CLI (set by `attentionos studio`), else apps/cli from source with tsx. */
export function cliCommand(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[]; cwd?: string } | null {
  if (env.ATTENTIONOS_CLI) {
    try {
      const parts = JSON.parse(env.ATTENTIONOS_CLI) as unknown;
      if (Array.isArray(parts) && parts.length && parts.every((p) => typeof p === "string")) return { cmd: parts[0] as string, args: parts.slice(1) as string[] };
    } catch {
      // fall through
    }
  }
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const bin = join(dir, "apps", "cli", "src", "bin.ts");
    if (existsSync(bin)) return { cmd: process.execPath, args: ["--import", "tsx", bin], cwd: dir };
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const MARKS: Record<string, CheckStatus> = { "✓": "pass", "!": "warn", "✗": "fail", "-": "skip" };

/** Reads the CLI doctor's checklist: section titles, `✓ ! ✗ -` lines (label, two spaces, detail) and `→` fixes. */
export function parseDoctorOutput(text: string): { sections: DoctorSection[]; summary: string } {
  const sections: DoctorSection[] = [];
  let current: DoctorSection | null = null;
  let summary = "";
  for (const raw of text.replace(ANSI, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const check = /^ {2}([✓!✗-]) (.*)$/.exec(raw);
    if (check) {
      const [label, ...rest] = check[2]!.split(/ {2,}/);
      const item: DoctorCheck = { status: MARKS[check[1]!]!, label: label!.trim(), ...(rest.length ? { detail: rest.join("  ").trim() } : {}) };
      if (!current) sections.push((current = { title: "Checks", checks: [] }));
      current.checks.push(item);
      continue;
    }
    const fix = /^ {4,}→ (.*)$/.exec(raw);
    if (fix && current?.checks.length) {
      const last = current.checks.at(-1)!;
      last.fix = last.fix ? `${last.fix} ${fix[1]}` : fix[1];
      continue;
    }
    if (!raw.startsWith(" ")) {
      if (/problem|warning|good|Ready/i.test(raw) && sections.length) summary = raw.trim();
      else sections.push((current = { title: raw.trim(), checks: [] }));
    }
  }
  return { sections: sections.filter((s) => s.checks.length), summary };
}

function runCli(root: string, timeoutMs: number): Promise<string | null> {
  const cli = cliCommand();
  if (!cli) return Promise.resolve(null);
  return new Promise((done) => {
    let out = "";
    const child = spawn(cli.cmd, [...cli.args, "doctor", "-w", root], {
      cwd: cli.cwd ?? root,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      done(/[✓✗]/.test(out) ? out : null);
    });
  });
}

function which(bin: string, args: string[]): Promise<string | null> {
  return new Promise((done) => execFile(bin, args, { timeout: 10_000 }, (err, stdout) => done(err ? null : String(stdout).split("\n")[0]!.trim())));
}

async function fallbackChecks(ws: StudioWorkspace): Promise<DoctorSection[]> {
  const tools: DoctorCheck[] = [];
  const ffmpeg = await which("ffmpeg", ["-version"]);
  tools.push(ffmpeg ? { status: "pass", label: "ffmpeg", detail: ffmpeg.split(" ").slice(0, 3).join(" ") } : { status: "warn", label: "ffmpeg not found (needed for editing, level 2)", fix: process.platform === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg" });
  const uv = await which("uv", ["--version"]);
  tools.push(uv ? { status: "pass", label: "uv", detail: uv } : { status: "warn", label: "uv not found (needed for editing, level 2)", fix: "attentionos doctor --fix installs it" });
  const claude = await which("claude", ["--version"]);
  tools.push(claude ? { status: "pass", label: "Claude Code", detail: claude } : { status: "fail", label: "Claude Code not found", fix: "npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in" });
  const db: DoctorCheck[] = [];
  const ping = await withTimeout(
    ws.sql`select 1`.then(
      () => null,
      (e: unknown) => (e as Error).message,
    ),
    8000,
    "timed out",
  );
  db.push(ping === null ? { status: "pass", label: "Database connection" } : { status: "fail", label: "Can't reach the database", detail: ping, fix: "Check DATABASE_URL in your workspace .env" });
  return [
    { title: "Tools on this computer", checks: tools },
    { title: "Database", checks: db },
  ];
}

/** Runs the doctor. Takes up to a few minutes when the speech test runs. */
export async function runStudioDoctor(): Promise<DoctorReport> {
  const ws = workspace();
  const output = await runCli(ws.root, 5 * 60_000);
  let sections: DoctorSection[];
  let summary = "";
  let source: DoctorReport["source"] = "cli";
  if (output) {
    ({ sections, summary } = parseDoctorOutput(output));
  } else {
    source = "studio";
    sections = await fallbackChecks(ws);
  }

  const worker = await workerState(ws).catch(() => null);
  const autopilot = ws.config.mode === "autopilot";
  sections.push({
    title: "Autopilot worker",
    checks: [
      worker?.online
        ? { status: "pass", label: "Worker is online", detail: worker.running ? `${worker.running} running now` : "idle" }
        : {
            status: autopilot ? "fail" : "skip",
            label: "Worker is offline",
            detail: worker?.lastSeen ? `last seen ${new Date(worker.lastSeen).toLocaleString()}` : "never started",
            fix: "The worker runs with Studio in the Docker stack. From your AttentionOS folder: `./aos restart`, then `./aos logs` if it stays offline.",
          },
    ],
  });

  const all = sections.flatMap((s) => s.checks);
  const failed = all.filter((c) => c.status === "fail").length;
  const warned = all.filter((c) => c.status === "warn").length;
  if (source === "studio" || !summary) summary = failed ? `${failed} to fix${warned ? `, ${warned} warnings` : ""}.` : warned ? `Ready, with ${warned} warnings.` : "Everything looks good.";
  return { source, ranAt: new Date().toISOString(), sections, summary, failed, warned };
}

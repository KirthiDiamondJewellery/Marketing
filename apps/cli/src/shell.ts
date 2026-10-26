import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

export type ExecResult = { ok: boolean; code: number | null; stdout: string; stderr: string; missing: boolean };

/** Runs a program without a shell and captures its output. `missing` = the program isn't installed. */
export function exec(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 20_000, cwd: opts.cwd, env: opts.env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      resolve({
        ok: !e,
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        missing: e?.code === "ENOENT",
      });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Runs a command with the terminal attached (installers, downloads). Resolves with the exit code. */
export function run(cmd: string, args: string[], opts: { cwd?: string; shell?: boolean } = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: opts.cwd, shell: opts.shell ?? false });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Yes/no question. Without a terminal it answers `fallback` (so scripts never hang). */
export async function confirm(question: string, opts: { yes?: boolean; fallback?: boolean } = {}): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) return opts.fallback ?? false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

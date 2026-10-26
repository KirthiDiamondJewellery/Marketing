import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the Python sidecar: `uv run --project <media-py> attentionos-media <command>` with JSON on stdin and one
 * JSON document on stdout. Progress lines (`{"progress": "..."}` on stderr) are forwarded to `onProgress`.
 */

export type MediaPyCommand = "probe" | "prep" | "asr" | "cut-plan" | "render" | "finish" | "qc" | "synth" | "embed" | "trial-plan" | "trial-render" | "trial-verify" | "version" | `models ${"list" | "path" | "download"}`;

export type MediaPyErrorCode =
  | "uv_missing"
  | "ffmpeg_missing"
  | "project_missing"
  | "timeout"
  | "aborted"
  | "bad_output"
  | "spawn_failed"
  // codes reported by media-py itself
  | "bad_input"
  | "not_found"
  | "model_missing"
  | "asr_engine_missing"
  | "asset_missing"
  | "ffmpeg_failed"
  | "internal"
  | (string & {});

export class MediaPyError extends Error {
  constructor(
    public readonly code: MediaPyErrorCode,
    message: string,
    public readonly fix?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MediaPyError";
  }
}

export type MediaPyOptions = {
  /** media-py project dir. Default: $ATTENTIONOS_MEDIA_PY_DIR, else the repo's media-py next to this package. */
  projectDir?: string;
  /** uv binary. Default: $ATTENTIONOS_UV or `uv` on PATH. */
  uv?: string;
  /** Optional extras to include, e.g. ["asr", "vision"]. Installed once; later runs reuse them. */
  extras?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  onProgress?: (message: string) => void;
  /** Working directory for the process (relative paths in the input resolve against it). */
  cwd?: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));

export const UV_FIX =
  "Install uv (https://docs.astral.sh/uv/): macOS/Linux `curl -LsSf https://astral.sh/uv/install.sh | sh`, Windows `winget install astral-sh.uv`. `attentionos doctor --fix` does this for you.";
export const FFMPEG_FIX = "Install ffmpeg: macOS `brew install ffmpeg`, Ubuntu `sudo apt install ffmpeg`, Windows `winget install ffmpeg`.";

/** Default timeouts per command (ms). Rendering scales with length; these are ceilings for a ~90 s reel. */
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  probe: 30_000,
  version: 60_000,
  prep: 15 * 60_000,
  asr: 20 * 60_000,
  "cut-plan": 2 * 60_000,
  render: 20 * 60_000,
  finish: 5 * 60_000,
  qc: 5 * 60_000,
  synth: 2 * 60_000,
  // Includes a one-time model download (~70 MB) on first use.
  embed: 10 * 60_000,
  "trial-plan": 30_000,
  // A day of trial reels (9 by default, up to 50) of a ~60 s reel.
  "trial-render": 45 * 60_000,
  "trial-verify": 15 * 60_000,
  models: 60 * 60_000,
};

/** Extras each command benefits from (all optional: commands degrade gracefully without them). */
export const COMMAND_EXTRAS: Partial<Record<string, string[]>> = {
  asr: ["asr"],
  render: ["vision"],
  embed: ["embed"],
  // Transcribes the clean reel itself when no word timings are passed in.
  "trial-render": ["asr"],
};

/**
 * Where media-py lives. Overridable so a bundled CLI can point at its shipped copy (e.g. `dist/assets/media-py`):
 * explicit option → $ATTENTIONOS_MEDIA_PY_DIR → ($ATTENTIONOS_MEDIA_PY, older name) → `<repo>/media-py`.
 * uv keeps the environment in that folder's default `.venv`.
 */
export function mediaPyDir(override?: string): string {
  return override ?? process.env.ATTENTIONOS_MEDIA_PY_DIR ?? process.env.ATTENTIONOS_MEDIA_PY ?? resolve(HERE, "../../../media-py");
}

export function findBinary(name: string, envVar?: string): string | null {
  const fromEnv = envVar ? process.env[envVar] : undefined;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const first = probe.stdout.split(/\r?\n/).find((l) => l.trim());
  return first?.trim() ?? null;
}

function preflightTools(projectDir: string, uv: string | undefined, command: string): string {
  const uvBin = uv ?? findBinary("uv", "ATTENTIONOS_UV");
  if (!uvBin) throw new MediaPyError("uv_missing", "uv (the Python runner) is not installed.", UV_FIX);
  if (!existsSync(join(projectDir, "pyproject.toml"))) {
    throw new MediaPyError("project_missing", `media-py was not found at ${projectDir}.`, "Reinstall AttentionOS or set ATTENTIONOS_MEDIA_PY_DIR to the media-py folder.");
  }
  const needsFfmpeg = !["version", "embed", "models list", "models path", "models download"].includes(command);
  if (needsFfmpeg && !process.env.ATTENTIONOS_FFMPEG && !findBinary("ffmpeg")) {
    throw new MediaPyError("ffmpeg_missing", "ffmpeg is not installed or not on PATH.", FFMPEG_FIX);
  }
  return uvBin;
}

/**
 * Runs one media-py command. Resolves with the parsed JSON result; rejects with MediaPyError (stable `code`,
 * plain-language `message`, optional `fix`).
 */
export async function mediaPy<T = Record<string, unknown>>(command: MediaPyCommand, input: unknown = {}, opts: MediaPyOptions = {}): Promise<T> {
  const projectDir = mediaPyDir(opts.projectDir);
  const uv = preflightTools(projectDir, opts.uv, command);
  const [cmd, ...rest] = command.split(" ");
  const extras = opts.extras ?? COMMAND_EXTRAS[cmd!] ?? [];
  const args = ["run", "--quiet", "--project", projectDir, ...extras.flatMap((e) => ["--extra", e]), "attentionos-media", cmd!, ...rest];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUTS[cmd!] ?? 10 * 60_000;

  return new Promise<T>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(uv, args, {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, ...opts.env, PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(new MediaPyError("spawn_failed", `Could not start media-py: ${(err as Error).message}`, UV_FIX));
      return;
    }
    let stdout = "";
    let stderrTail = "";
    let stderrBuf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => !child.killed && child.kill("SIGKILL"), 3000).unref();
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new MediaPyError("timeout", `media-py ${command} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`, "Try a shorter clip, or raise the timeout.")));
    }, timeoutMs);
    const onAbort = () => {
      kill();
      finish(() => reject(new MediaPyError("aborted", `media-py ${command} was cancelled.`)));
    };
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => {
      stderrBuf += d;
      let nl: number;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith("{")) {
          try {
            const msg = JSON.parse(line) as { progress?: unknown };
            if (typeof msg.progress === "string") {
              opts.onProgress?.(msg.progress);
              continue;
            }
          } catch {
            // not a progress line
          }
        }
        stderrTail = (stderrTail + line + "\n").slice(-4000);
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(err.code === "ENOENT" ? new MediaPyError("uv_missing", "uv (the Python runner) is not installed.", UV_FIX) : new MediaPyError("spawn_failed", err.message)),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        const text = stdout.trim();
        const lastLine = text.slice(text.lastIndexOf("\n{") + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text.startsWith("{") ? text : lastLine);
        } catch {
          reject(
            new MediaPyError("bad_output", `media-py ${command} exited ${code} without a JSON result.`, describeStderr(stderrTail), {
              stdout: text.slice(-1000),
              stderr: stderrTail.slice(-2000),
            }),
          );
          return;
        }
        const err = (parsed as { error?: { code?: string; message?: string; fix?: string; details?: Record<string, unknown> } }).error;
        if (code !== 0 || err) {
          reject(new MediaPyError(err?.code ?? "internal", err?.message ?? `media-py ${command} failed (exit ${code}).`, err?.fix, { ...err?.details, stderr: stderrTail.slice(-1500) }));
          return;
        }
        resolvePromise(parsed as T);
      });
    });
    child.stdin.on("error", () => {
      // the process exited before reading stdin; the close handler reports it
    });
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

function describeStderr(stderr: string): string | undefined {
  if (/No interpreter found|python.*not found/i.test(stderr)) return "uv could not find Python 3.12. Run `uv python install 3.12`.";
  if (/Failed to (download|fetch)|network|resolve/i.test(stderr)) return "uv could not download media-py's Python packages. Check the internet connection and try again.";
  return undefined;
}

export type ToolCheck = { name: "uv" | "ffmpeg" | "ffprobe"; ok: boolean; path?: string; version?: string; fix?: string };

/** For `attentionos doctor`: is everything Level 2 needs on this machine? Spends nothing. */
export function checkMediaTools(): ToolCheck[] {
  const check = (name: ToolCheck["name"], env: string, versionArgs: string[], fix: string): ToolCheck => {
    const path = findBinary(name, env);
    if (!path) return { name, ok: false, fix };
    const v = spawnSync(path, versionArgs, { encoding: "utf8" });
    const version = (v.stdout || v.stderr).split(/\r?\n/)[0]?.trim();
    return { name, ok: v.status === 0, path, ...(version ? { version } : {}), ...(v.status === 0 ? {} : { fix }) };
  };
  return [
    check("uv", "ATTENTIONOS_UV", ["--version"], UV_FIX),
    check("ffmpeg", "ATTENTIONOS_FFMPEG", ["-version"], FFMPEG_FIX),
    check("ffprobe", "ATTENTIONOS_FFPROBE", ["-version"], FFMPEG_FIX),
  ];
}

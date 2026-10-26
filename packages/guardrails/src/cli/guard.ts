import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { mergeBanned, parseBannedFromVoiceMd } from "../banned.ts";
import { copyGuard, type CopyKind } from "../copy-guard.ts";
import { formatIssues } from "../issues.ts";

/**
 * `attentionos-guard`: blocks agent writes of scripts, captions and text posts that fail the copy gates.
 *
 *   attentionos-guard                   Claude Code PostToolUse hook: reads the hook JSON on stdin (as the
 *                                       plugin's hooks/run.mjs invokes it). Same as --hook.
 *   attentionos-guard --hook            Explicit hook mode.
 *   attentionos-guard [--kind K] FILE...  Checks files directly (exit 1 on failure).
 *
 * Hook contract (https://code.claude.com/docs/en/hooks): stdin carries `tool_name`, `tool_input.file_path`
 * and `cwd`. The tool has already run, so the file on disk is checked. Exit 0 = fine (or not a copy file);
 * exit 2 = the problems are written to stderr, which Claude Code shows to the model so it rewrites the file.
 * With `--json`, the hook prints `{"decision":"block","reason":...}` on stdout and exits 0 instead.
 *
 * Which files are copy (relative to the workspace root: the folder holding brand/brand.yaml or
 * config/attentionos.config.ts). Brand Kit files themselves are never checked (voice.md lists banned words):
 * - script:    *.script.md, or any .md under a `scripts/` folder
 * - captions:  *.captions.json, or any .json under a `captions/` folder
 * - text_post: *.textposts.json, or any .json under a `text-posts/` folder
 */

export type GuardIO = {
  stdin: () => Promise<string>;
  /** True when stdin is an interactive terminal (no hook payload can arrive). */
  stdinIsTTY?: boolean;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function detectKind(filePath: string): CopyKind | null {
  const p = filePath.split(sep).join("/");
  const name = basename(p).toLowerCase();
  if (name.endsWith(".script.md")) return "script";
  if (name.endsWith(".captions.json")) return "captions";
  if (name.endsWith(".textposts.json")) return "text_post";
  const dirs = p.toLowerCase().split("/").slice(0, -1);
  if (name.endsWith(".md") && dirs.includes("scripts")) return "script";
  if (name.endsWith(".json") && dirs.includes("captions")) return "captions";
  if (name.endsWith(".json") && dirs.includes("text-posts")) return "text_post";
  return null;
}

/** Walks up from `start` to the folder that holds brand/brand.yaml. */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "brand", "brand.yaml")) || existsSync(join(dir, "config", "attentionos.config.ts")) || existsSync(join(dir, "config", "attentionos.config.js"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type BrandRules = { bannedOpeners: string[]; bannedPhrases: string[]; hashtagPool: string[]; problems: string[] };

/** Reads the banned lists and hashtag pool from a workspace's Brand Kit without loading the whole kit. */
export function loadBrandRules(root: string | null): BrandRules {
  const out: BrandRules = { bannedOpeners: [], bannedPhrases: [], hashtagPool: [], problems: [] };
  if (!root) return out;
  const yamlPath = join(root, "brand", "brand.yaml");
  try {
    const doc = (parseYaml(readFileSync(yamlPath, "utf8")) ?? {}) as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    out.bannedPhrases.push(...strings(doc.bannedPhrases));
    out.hashtagPool.push(...strings(doc.hashtagPool));
  } catch (err) {
    out.problems.push(`brand/brand.yaml couldn't be read (${(err as Error).message}); checked with the default rules only.`);
  }
  const voicePath = join(root, "brand", "voice.md");
  if (existsSync(voicePath)) {
    const voice = parseBannedFromVoiceMd(readFileSync(voicePath, "utf8"));
    const merged = mergeBanned({ phrases: out.bannedPhrases }, voice);
    out.bannedOpeners = merged.openers;
    out.bannedPhrases = merged.phrases;
  }
  return out;
}

/** Checks one file. Returns the problem report, or null when it passes or isn't a copy file. */
export function checkFile(filePath: string, opts: { kind?: CopyKind; cwd?: string; fallbackContent?: string } = {}): { kind: CopyKind; report: string; ok: boolean } | null {
  const abs = resolve(opts.cwd ?? process.cwd(), filePath);
  const root = findWorkspaceRoot(dirname(abs));
  const rel = root ? relative(root, abs) : abs;
  const kind = opts.kind ?? detectKind(rel);
  if (!kind) return null;
  let text: string;
  if (existsSync(abs)) text = readFileSync(abs, "utf8");
  else if (opts.fallbackContent !== undefined) text = opts.fallbackContent;
  else return null;
  const brand = loadBrandRules(root);
  const result = copyGuard(text, { kind, bannedOpeners: brand.bannedOpeners, bannedPhrases: brand.bannedPhrases, hashtagPool: brand.hashtagPool });
  if (result.ok) return { kind, ok: true, report: "" };
  const what = kind === "script" ? "script" : kind === "captions" ? "captions" : "text post";
  const report = [
    `AttentionOS copy check failed for the ${what} in ${rel}:`,
    formatIssues(result),
    ...brand.problems,
    "Rewrite the file to fix every item, then save it again. The checks are fixed rules; don't change them.",
  ].join("\n");
  return { kind, ok: false, report };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export const processIO: GuardIO = {
  stdin: readAllStdin,
  stdinIsTTY: process.stdin.isTTY === true,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
};

/** Runs the CLI and returns the exit code. */
export async function runGuard(argv: readonly string[], io: GuardIO = processIO): Promise<number> {
  const args = [...argv];
  const json = args.includes("--json");
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout("Usage: attentionos-guard --hook [--json]   |   attentionos-guard [--kind script|captions|text_post] FILE...\n");
    return 0;
  }
  const fileArgs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--kind");
  // No files given: hook mode, as the plugin launcher calls it (hook JSON on stdin).
  if (args.includes("--hook") || (fileArgs.length === 0 && !io.stdinIsTTY)) {
    let payload: { tool_name?: string; tool_input?: { file_path?: string; content?: string; file_content?: string }; cwd?: string };
    try {
      payload = JSON.parse(await io.stdin());
    } catch {
      return 0; // not a hook payload we understand: never block on our own parsing problems
    }
    if (payload.tool_name && !WRITE_TOOLS.has(payload.tool_name)) return 0;
    const filePath = payload.tool_input?.file_path;
    if (!filePath) return 0;
    const res = checkFile(filePath, { cwd: payload.cwd, fallbackContent: payload.tool_input?.content ?? payload.tool_input?.file_content });
    if (!res || res.ok) return 0;
    if (json) {
      io.stdout(JSON.stringify({ decision: "block", reason: res.report }) + "\n");
      return 0;
    }
    io.stderr(res.report + "\n");
    return 2;
  }

  let kind: CopyKind | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--kind") {
      const k = args[++i];
      if (k !== "script" && k !== "captions" && k !== "text_post") {
        io.stderr(`--kind must be script, captions or text_post (got ${k ?? "nothing"}).\n`);
        return 64;
      }
      kind = k;
    } else if (!a.startsWith("--")) files.push(a);
  }
  if (files.length === 0) {
    io.stderr("Give one or more files to check, or --hook to read a Claude Code hook payload on stdin.\n");
    return 64;
  }
  let failed = 0;
  for (const f of files) {
    const res = checkFile(f, { kind });
    if (!res) {
      io.stderr(`${f}: skipped (not a script, captions or text post file; pass --kind to force).\n`);
      continue;
    }
    if (!res.ok) {
      failed++;
      io.stderr(res.report + "\n\n");
    }
  }
  if (failed === 0) io.stdout(`Copy check passed (${files.length} file${files.length === 1 ? "" : "s"}).\n`);
  return failed > 0 ? 1 : 0;
}

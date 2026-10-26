#!/usr/bin/env node
// AttentionOS hook launcher for Claude Code. Zero dependencies; runs on Node 22+ on macOS, Linux and Windows.
//
//   node run.mjs session-start   SessionStart: prints approvals waiting and today's filming as session context
//   node run.mjs copy-guard      PostToolUse (Write|Edit|MultiEdit): runs the deterministic copy guard on
//                                Brand Kit and content files, so banned phrases are caught as they're written
//
// Both hooks only act inside an AttentionOS workspace (a folder with config/attentionos.config.ts) and fail
// open: if the CLI isn't installed or the database is unreachable, the session carries on untouched.
// The workspace's own install (node_modules/.bin) is preferred, then `attentionos` on PATH (inside the Docker
// stack). Nothing is downloaded: without either, the hooks do nothing.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const mode = process.argv[2];
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const isWindows = process.platform === "win32";

const COPY_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".yaml", ".yml", ".json"]);
// Folders whose text is copy: the Brand Kit and anything the agents draft for the audience.
const COPY_FOLDERS = ["brand", "content", "scripts", "captions", "drafts"];

function isWorkspace(dir) {
  return existsSync(join(dir, "config", "attentionos.config.ts")) || existsSync(join(dir, "config", "attentionos.config.js"));
}

function readStdin() {
  return new Promise((resolveRead) => {
    if (process.stdin.isTTY) return resolveRead("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolveRead(data));
    process.stdin.on("error", () => resolveRead(data));
  });
}

/** Local bin first (pinned to the workspace's version), then the command on PATH. Never downloads anything. */
function commandFor(bin, args) {
  const local = join(projectDir, "node_modules", ".bin", isWindows ? `${bin}.cmd` : bin);
  if (existsSync(local)) return { cmd: local, args };
  return { cmd: bin, args };
}

function run(bin, args, input, timeoutMs) {
  return new Promise((done) => {
    const { cmd, args: argv } = commandFor(bin, args);
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, argv, { cwd: projectDir, env: process.env, shell: isWindows, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return done({ code: null, stdout, stderr });
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", () => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function isCopyFile(filePath) {
  if (typeof filePath !== "string" || !filePath) return false;
  const full = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
  const rel = relative(projectDir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  const top = rel.split(sep)[0];
  return COPY_FOLDERS.includes(top) && COPY_EXTENSIONS.has(extname(full).toLowerCase());
}

async function sessionStart() {
  const input = await readStdin();
  if (!isWorkspace(projectDir)) return 0;
  const r = await run("attentionos", ["hook", "session-start"], input, 20_000);
  if (r.code === 0 && r.stdout.trim()) process.stdout.write(r.stdout.trim() + "\n");
  return 0; // never block a session
}

async function copyGuard() {
  const input = await readStdin();
  if (!isWorkspace(projectDir)) return 0;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return 0;
  }
  // Write, Edit and MultiEdit all name the file in tool_input.file_path.
  if (!isCopyFile(event?.tool_input?.file_path)) return 0;
  const r = await run("attentionos-guard", [], input, 45_000);
  if (r.code === null) return 0; // guard not installed or timed out: fail open
  // The guard may answer with hook JSON on stdout ({"decision":"block","reason":...}) or with exit code 2 and
  // findings on stderr; both are passed through unchanged.
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  // Exit 2 tells Claude Code to show the guard's findings to Claude so it fixes the copy.
  return r.code === 2 ? 2 : 0;
}

const handlers = { "session-start": sessionStart, "copy-guard": copyGuard };
const handler = handlers[mode];
if (!handler) {
  process.stderr.write(`attentionos hook: unknown mode "${mode}"\n`);
  process.exit(0);
}
handler().then(
  (code) => process.exit(code),
  () => process.exit(0),
);

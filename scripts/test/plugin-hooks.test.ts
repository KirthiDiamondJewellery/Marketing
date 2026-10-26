import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const RUNNER = join(import.meta.dirname, "..", "..", "plugin-src", "hooks", "run.mjs");
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A fake workspace whose node_modules/.bin holds stub CLIs, so no network or npx is involved. */
function workspace(bins: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), "hooks-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "attentionos.config.ts"), "export default {};\n");
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  for (const [name, script] of Object.entries(bins)) {
    const p = join(dir, "node_modules", ".bin", name);
    writeFileSync(p, `#!/usr/bin/env node\n${script}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

function hook(mode: string, projectDir: string, input: unknown) {
  return spawnSync(process.execPath, [RUNNER, mode], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf8",
    timeout: 15_000,
  });
}

const edit = (filePath: string) => ({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: filePath, content: "x" } });

describe.skipIf(process.platform === "win32")("plugin hooks", () => {
  it("does nothing outside an AttentionOS workspace", () => {
    dir = mkdtempSync(join(tmpdir(), "hooks-"));
    expect(hook("session-start", dir, {}).status).toBe(0);
    const r = hook("copy-guard", dir, edit(join(dir, "brand", "voice.md")));
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("prints the session-start summary from the workspace CLI", () => {
    const ws = workspace({ attentionos: 'if (process.argv.slice(2).join(" ") === "hook session-start") console.log("AttentionOS: 2 approvals waiting.");' });
    const r = hook("session-start", ws, { hook_event_name: "SessionStart", source: "startup" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("AttentionOS: 2 approvals waiting.\n");
  });

  it("never blocks a session when the CLI fails", () => {
    const ws = workspace({ attentionos: "console.error('database unreachable'); process.exit(1);" });
    const r = hook("session-start", ws, {});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("runs the copy guard on Brand Kit files and passes its findings to Claude", () => {
    const ws = workspace({
      "attentionos-guard": "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const e=JSON.parse(s);console.error('banned phrase in '+e.tool_input.file_path);process.exit(2);});",
    });
    const r = hook("copy-guard", ws, edit(join(ws, "brand", "voice.md")));
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`banned phrase in ${join(ws, "brand", "voice.md")}\n`);
  });

  it("skips files that aren't copy, files outside the workspace and unreadable input", () => {
    const ws = workspace({ "attentionos-guard": "process.exit(2);" });
    expect(hook("copy-guard", ws, edit(join(ws, "config", "attentionos.config.ts"))).status).toBe(0);
    expect(hook("copy-guard", ws, edit(join(ws, "media", "raw", "notes.md"))).status).toBe(0);
    expect(hook("copy-guard", ws, edit("/elsewhere/brand/voice.md")).status).toBe(0);
    expect(hook("copy-guard", ws, "not json").status).toBe(0);
  });
});

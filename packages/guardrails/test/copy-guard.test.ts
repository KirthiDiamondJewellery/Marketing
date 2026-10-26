import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkRubric, copyGuard, guardDetectKind, parseScriptFile, runGuard, validateTextPost, type GuardIO } from "../src/index.ts";
import { codes, validCaptions, warnCodes } from "./fixtures.ts";

const BIN = resolve(import.meta.dirname, "../bin/attentionos-guard.mjs");

/** The bin imports .ts sources, so plain node needs built-in type stripping: Node 22.18+, 23.6+ or 24+. */
const [NODE_MAJOR = 0, NODE_MINOR = 0] = process.versions.node.split(".").map(Number);
const TYPE_STRIPPING = NODE_MAJOR >= 24 || (NODE_MAJOR === 23 && NODE_MINOR >= 6) || (NODE_MAJOR === 22 && NODE_MINOR >= 18);
const NEEDS_TYPE_STRIPPING = TYPE_STRIPPING ? "" : ` (skipped: needs Node 22.18+ for type stripping, this is ${process.versions.node})`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "aos-guard-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "brand"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "captions"));
  writeFileSync(join(dir, "brand", "brand.yaml"), "name: Examplebrand Studio\nbannedPhrases:\n  - dream home\nhashtagPool: []\n");
  writeFileSync(join(dir, "brand", "voice.md"), "# Voice\n\n## Banned openers\n- \"So here's the deal\"\n\n## Never say\n- \"luxury\"\n");
  return dir;
}

const GOOD_SCRIPT = "---\nkeyword: blueprint\n---\n# Why budgets break\n\nYour remodel budget breaks before demolition even starts. Comment BLUEPRINT and I'll send you the checklist.\n";

describe("copyGuard", () => {
  it("parses frontmatter and title out of a script file", () => {
    expect(parseScriptFile(GOOD_SCRIPT)).toEqual({ meta: { keyword: "blueprint" }, title: "Why budgets break", body: "Your remodel budget breaks before demolition even starts. Comment BLUEPRINT and I'll send you the checklist." });
  });
  it.each([
    [GOOD_SCRIPT, []],
    ["# T\n\nSo here's the deal, budgets break.", ["script.banned_opener"]],
    ["# T\n\nThe luxury kitchen [b-roll] costs more \u2014 a lot.", ["spoken.brackets", "punctuation.dash", "script.banned_phrase"]],
    ["# T\n\n", ["copy.empty"]],
  ])("script %#", (text, expected) => {
    expect(codes(copyGuard(text, { kind: "script", bannedOpeners: ["So here's the deal"], bannedPhrases: ["luxury"] }))).toEqual(expected);
  });
  it("captions JSON, plain or wrapped with its CTA context", () => {
    expect(copyGuard(JSON.stringify(validCaptions()), { kind: "captions" }).ok).toBe(true);
    const wrapped = { ctaType: "comment_keyword", keyword: "blueprint", captions: { ...validCaptions(), tiktok: { caption: "Comment BLUEPRINT", hashtags: ["#a1", "#a2", "#a3"] } } };
    expect(codes(copyGuard(JSON.stringify(wrapped), { kind: "captions" }))).toEqual(["captions.offplatform_cta", "captions.comment_keyword_off_instagram"]);
    expect(codes(copyGuard("{not json", { kind: "captions" }))).toEqual(["copy.invalid_json"]);
  });
  it("detects file kinds by path", () => {
    expect(guardDetectKind("scripts/2026-10-15/reel.md")).toBe("script");
    expect(guardDetectKind("drafts/reel.script.md")).toBe("script");
    expect(guardDetectKind("captions/reel.json")).toBe("captions");
    expect(guardDetectKind("out/reel.captions.json")).toBe("captions");
    expect(guardDetectKind("text-posts/week.json")).toBe("text_post");
    expect(guardDetectKind("brand/voice.md")).toBeNull();
  });
});

describe("text posts and rubric", () => {
  const rubric = { hook: 8, clarity: 9, usefulness: 8, accuracy: 9, formatting: 8, cta: 8 };
  it.each([
    [{ platform: "x", text: "Remodel budgets break in week one.", hashtags: [] }, []],
    [{ platform: "x", text: "a".repeat(281) }, ["text_post.too_long"]],
    [{ platform: "threads", text: "a".repeat(501) }, ["text_post.too_long"]],
    [{ platform: "linkedin", text: "Budgets break early.\n\nHere is why.", hashtags: ["#designbuild", "#remodeling", "#construction"], rubric }, []],
    [{ platform: "linkedin", text: "Budgets break early.", hashtags: ["#designbuild", "#remodeling", "#construction"] }, ["rubric.missing"]],
    [{ platform: "linkedin", text: "Budgets break early.", hashtags: ["#designbuild"], rubric }, ["hashtags.count"]],
    [{ platform: "x", text: "Your dream home \u2014 costs more.", hashtags: [] }, ["text_post.banned_phrase", "punctuation.dash"]],
    [{ platform: "x", text: "Budgets #remodel", hashtags: [] }, ["text_post.inline_hashtags"]],
    [{ platform: "mastodon", text: "x" }, ["text_post.shape"]],
  ] as const)("%j", (post, expected) => {
    expect(codes(validateTextPost(post, { bannedPhrases: ["dream home"] }))).toEqual(expected);
  });
  it.each([
    [{ hook: 8, clarity: 8 }, []],
    [{ hook: 10, clarity: 6 }, ["rubric.below_floor"]],
    [{ hook: 7, clarity: 8 }, ["rubric.below_bar"]],
    [{ hook: 11, clarity: 8 }, ["rubric.out_of_range"]],
    [{ hook: 8 }, ["rubric.criterion_missing"]],
  ])("rubric %j", (scores, expected) => {
    expect(codes(checkRubric(scores, { criteria: ["hook", "clarity"] }))).toEqual(expected);
  });
  it("linkedin with a visual needs the visual criteria too", () => {
    expect(codes(validateTextPost({ platform: "linkedin", text: "Budgets break.", hashtags: ["#a1", "#a2", "#a3"], rubric, hasVisual: true }))).toContain("rubric.criterion_missing");
  });
  it("warns past the LinkedIn fold", () => {
    expect(warnCodes(validateTextPost({ platform: "linkedin", text: "a ".repeat(120), hashtags: ["#a1", "#a2", "#a3"], rubric }))).toContain("text_post.linkedin_fold");
  });
});

describe("attentionos-guard CLI", () => {
  const io = (stdin = "") => {
    const out: string[] = [];
    const err: string[] = [];
    const handle: GuardIO = { stdin: async () => stdin, stdout: (s) => void out.push(s), stderr: (s) => void err.push(s) };
    return { handle, out, err };
  };

  it("hook mode: blocks a bad script with exit 2 and plain-language stderr", async () => {
    const dir = workspace();
    const file = join(dir, "scripts", "reel.md");
    writeFileSync(file, "# T\n\nSo here's the deal, your dream home costs more [B-ROLL].\n");
    const { handle, err } = io(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, cwd: dir }));
    expect(await runGuard(["--hook"], handle)).toBe(2);
    const text = err.join("");
    expect(text).toContain("copy check failed for the script in scripts/reel.md");
    expect(text).toContain("So here's the deal");
    expect(text).toContain("dream home");
  });

  it("hook mode: --json prints a block decision instead", async () => {
    const dir = workspace();
    const file = join(dir, "scripts", "reel.md");
    writeFileSync(file, "# T\n\nThe luxury kitchen costs more.\n");
    const { handle, out } = io(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir }));
    expect(await runGuard(["--hook", "--json"], handle)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ decision: "block" });
  });

  it("hook mode: passes good files, other tools and non-copy files", async () => {
    const dir = workspace();
    const good = join(dir, "scripts", "good.md");
    writeFileSync(good, GOOD_SCRIPT);
    writeFileSync(join(dir, "notes.md"), "So here's the deal [x]");
    for (const payload of [
      { tool_name: "Write", tool_input: { file_path: good }, cwd: dir },
      { tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir },
      { tool_name: "Write", tool_input: { file_path: join(dir, "notes.md") }, cwd: dir },
    ]) {
      expect(await runGuard(["--hook"], io(JSON.stringify(payload)).handle)).toBe(0);
    }
    expect(await runGuard(["--hook"], io("not json").handle)).toBe(0);
  });

  it("file mode exits 1 on failure", async () => {
    const dir = workspace();
    const file = join(dir, "captions", "reel.json");
    writeFileSync(file, JSON.stringify({ instagram: { caption: "Hi \u2014 there", hashtags: ["#fyp"] } }));
    const { handle, err } = io();
    expect(await runGuard([file], handle)).toBe(1);
    expect(err.join("")).toContain("captions");
  });

  it.skipIf(!TYPE_STRIPPING)(`the bin runs under plain node (type stripping)${NEEDS_TYPE_STRIPPING}`, () => {
    const dir = workspace();
    const file = join(dir, "scripts", "reel.md");
    writeFileSync(file, "# T\n\nLet me explain the luxury kitchen.\n");
    const res = spawnSync(process.execPath, [BIN, "--hook"], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file }, cwd: dir }), encoding: "utf8" });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("Let me explain");
  });
});

describe("plugin launcher contract (plugin-src/hooks/run.mjs)", () => {
  const RUN_MJS = resolve(import.meta.dirname, "../../../plugin-src/hooks/run.mjs");

  /** A workspace the launcher recognises: config/attentionos.config.ts, no brand.yaml needed. */
  function pluginWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "aos-plugin-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "config"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "brand"));
    writeFileSync(join(dir, "config", "attentionos.config.ts"), "export default {};\n");
    writeFileSync(join(dir, "brand", "voice.md"), "## Never say\n- \"luxury\"\n");
    return dir;
  }

  it("no arguments + hook JSON on stdin = hook mode (exit 2, findings on stderr)", async () => {
    const dir = pluginWorkspace();
    const file = join(dir, "scripts", "reel.md");
    writeFileSync(file, "# T\n\nLet me explain the luxury kitchen.\n");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runGuard([], { stdin: async () => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, cwd: dir }), stdinIsTTY: false, stdout: (s) => void out.push(s), stderr: (s) => void err.push(s) });
    expect(code).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("")).toContain("Let me explain");
    expect(err.join("")).toContain("luxury");
  });

  it("no arguments on a terminal prints usage instead of waiting for stdin", async () => {
    const err: string[] = [];
    expect(await runGuard([], { stdin: async () => { throw new Error("must not read"); }, stdinIsTTY: true, stdout: () => {}, stderr: (s) => void err.push(s) })).toBe(64);
    expect(err.join("")).toContain("--hook");
  });

  it("Brand Kit files are never blocked even though they list banned words", async () => {
    const dir = pluginWorkspace();
    const code = await runGuard([], { stdin: async () => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, "brand", "voice.md") }, cwd: dir }), stdinIsTTY: false, stdout: () => {}, stderr: () => {} });
    expect(code).toBe(0);
  });

  it("the launcher exists", () => {
    expect(existsSync(RUN_MJS), `missing ${RUN_MJS}`).toBe(true);
  });

  it.skipIf(!TYPE_STRIPPING)(`end to end through run.mjs copy-guard with the workspace's local bin${NEEDS_TYPE_STRIPPING}`, () => {
    const dir = pluginWorkspace();
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(BIN, join(dir, "node_modules", ".bin", "attentionos-guard"));
    const file = join(dir, "scripts", "reel.md");
    const payload = (f: string) => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: f }, cwd: dir });
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };

    writeFileSync(file, "# T\n\nLet me explain the luxury kitchen [b-roll].\n");
    const bad = spawnSync(process.execPath, [RUN_MJS, "copy-guard"], { input: payload(file), encoding: "utf8", env, cwd: dir });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("copy check failed for the script in scripts/reel.md");

    writeFileSync(file, "# T\n\nYour remodel budget breaks before demolition even starts.\n");
    const good = spawnSync(process.execPath, [RUN_MJS, "copy-guard"], { input: payload(file), encoding: "utf8", env, cwd: dir });
    expect(good.status).toBe(0);
    expect(good.stderr).toBe("");
  });
});

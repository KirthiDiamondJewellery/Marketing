import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assemblePlugin, buildPlugin, parseFrontMatter, PluginBuildError, readTree } from "../build-plugin.ts";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function put(rel: string, text: string) {
  const full = join(root!, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

const skill = (name: string, description = `Use ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function fakeRepo() {
  root = mkdtempSync(join(tmpdir(), "plugin-build-"));
  put("plugin-src/plugin.json", JSON.stringify({ name: "attention", version: "0.1.0", description: "test" }));
  put("plugin-src/commands/brief.md", "---\ndescription: Morning brief\nallowed-tools: Read\n---\n\nRun the brief.\n");
  put("plugin-src/agents/analyst.md", "---\nname: analyst\ndescription: Research and measurement.\ntools: Read, mcp__attentionos__*\nmodel: sonnet\n---\n\nYou are the Analyst.\n");
  put("plugin-src/hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs" session-start' }] }] } }));
  put("plugin-src/hooks/run.mjs", "process.exit(0);\n");
  put("modules/research/module.json", "{}");
  put("modules/research/skills/trend-desk/SKILL.md", skill("trend-desk"));
  put("modules/research/skills/trend-desk/references/heat.md", "How heat works.\n");
  put("modules/scripting/skills/hook-audit/SKILL.md", "---\nname: hook-audit\ndescription: >\n  Audit a hook for the four killers\n  and an open loop.\n---\n\nBody\n");
  put("modules/scripting/skills/draft/notes.txt", "no SKILL.md yet");
  put("modules/editing/src/index.ts", "export {};\n");
}

describe("parseFrontMatter", () => {
  it("reads scalars, quoted strings, inline and block lists, and folded text", () => {
    const fm = parseFrontMatter(
      '---\nname: copywriter\ndescription: "Words: scripts, hooks"\ntools: [Read, Grep]\nskills:\n  - hook-audit\n  - voice\nlong: >\n  one\n  two\n---\nbody',
    );
    expect(fm?.data).toEqual({ name: "copywriter", description: "Words: scripts, hooks", tools: ["Read", "Grep"], skills: ["hook-audit", "voice"], long: "one two" });
    expect(fm?.body).toBe("body");
    expect(parseFrontMatter("no front matter")).toBeNull();
  });
});

describe("plugin build", () => {
  it("assembles the manifest, commands, agents, hooks and every module's skills", () => {
    fakeRepo();
    const r = buildPlugin({ root: root! });
    const out = readTree(r.outDir);
    expect([...out.keys()].sort()).toEqual([
      ".claude-plugin/plugin.json",
      "README.md",
      "agents/analyst.md",
      "commands/brief.md",
      "hooks/hooks.json",
      "hooks/run.mjs",
      "skills/hook-audit/SKILL.md",
      "skills/trend-desk/SKILL.md",
      "skills/trend-desk/references/heat.md",
    ]);
    expect(r.skills).toEqual([
      { name: "trend-desk", module: "research", description: "Use trend-desk.", files: 2 },
      { name: "hook-audit", module: "scripting", description: "Audit a hook for the four killers and an open loop.", files: 1 },
    ].sort((a, b) => a.module.localeCompare(b.module)));
    expect(r.warnings).toEqual(["modules/scripting/skills/draft: no SKILL.md yet, skipped"]);
    expect(JSON.parse(readFileSync(join(r.outDir, ".claude-plugin/plugin.json"), "utf8")).name).toBe("attention");
    const readme = readFileSync(join(r.outDir, "README.md"), "utf8");
    expect(readme).toContain("| `/attention:brief` | Morning brief |");
    expect(readme).toContain("| `hook-audit` | scripting |");
  });

  it("replaces stale output on rebuild", () => {
    fakeRepo();
    buildPlugin({ root: root! });
    put("plugin/skills/removed-skill/SKILL.md", skill("removed-skill"));
    buildPlugin({ root: root! });
    expect(readTree(join(root!, "plugin")).has("skills/removed-skill/SKILL.md")).toBe(false);
  });

  it("--check reports missing, changed and extra files", () => {
    fakeRepo();
    expect(buildPlugin({ root: root!, check: true }).upToDate).toBe(false);
    buildPlugin({ root: root! });
    expect(buildPlugin({ root: root!, check: true }).upToDate).toBe(true);
    put("modules/research/skills/trend-desk/SKILL.md", skill("trend-desk", "Changed."));
    put("plugin/stray.txt", "x");
    put("modules/learn/skills/post-mortem/SKILL.md", skill("post-mortem"));
    const r = buildPlugin({ root: root!, check: true });
    expect(r.upToDate).toBe(false);
    expect(r.diff).toEqual({ missing: ["skills/post-mortem/SKILL.md"], changed: ["README.md", "skills/trend-desk/SKILL.md"], extra: ["stray.txt"] });
  });

  it("fails on duplicate skill names across modules", () => {
    fakeRepo();
    put("modules/learn/skills/trend-desk/SKILL.md", skill("trend-desk"));
    expect(() => assemblePlugin(root!)).toThrow(/skill "trend-desk" exists in both modules\/learn and modules\/research/);
  });

  it("fails when a skill clashes with a command or agent name, or lacks a description", () => {
    fakeRepo();
    put("modules/ops/skills/brief/SKILL.md", skill("brief"));
    put("modules/ops/skills/analyst/SKILL.md", skill("analyst"));
    put("modules/ops/skills/no-desc/SKILL.md", "---\nname: no-desc\n---\n");
    let err: PluginBuildError | undefined;
    try {
      assemblePlugin(root!);
    } catch (e) {
      err = e as PluginBuildError;
    }
    expect(err?.problems).toEqual([
      'modules/ops/skills/analyst: "analyst" is also an agent name; rename the skill so attention:analyst means one thing',
      'modules/ops/skills/brief: "brief" clashes with the /attention:brief command; rename the skill',
      "modules/ops/skills/no-desc/SKILL.md: front matter needs a description",
    ]);
  });

  it("rejects agent fields that plugins ignore and mismatched names", () => {
    fakeRepo();
    put("plugin-src/agents/publisher.md", "---\nname: pub\ndescription: x\npermissionMode: auto\n---\n");
    expect(() => assemblePlugin(root!)).toThrow(/front matter name "pub" must match[\s\S]*"permissionMode" is ignored/);
  });

  it("checks that hook scripts exist", () => {
    fakeRepo();
    rmSync(join(root!, "plugin-src/hooks/run.mjs"));
    expect(() => assemblePlugin(root!)).toThrow(/SessionStart runs hooks\/run.mjs, which is not in plugin-src/);
  });

  it("refuses to write over the repository root", () => {
    fakeRepo();
    expect(() => buildPlugin({ root: root!, outDir: root! })).toThrow(/refusing/);
  });

  it("builds the real repository", () => {
    const real = join(dirname(new URL(import.meta.url).pathname), "..", "..");
    const r = assemblePlugin(real);
    expect(r.pluginName).toBe("attention");
    expect(r.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(["init", "brief", "research", "script", "edit", "publish", "inbox", "approvals", "learn", "doctor", "lesson"]),
    );
    expect(r.agents.map((a) => a.name).sort()).toEqual(["analyst", "art-director", "chief-of-staff", "community", "copywriter", "publisher", "strategist"]);
    expect(r.skills.some((s) => s.module === "ops" && s.name === "morning-brief")).toBe(true);
  });
});

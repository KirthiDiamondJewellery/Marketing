import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleManifestSchema } from "@attentionos/core";
import { describe, expect, it } from "vitest";
import mod, { ONBOARDING_JOBS } from "../src/index.ts";

describe("onboarding module definition", () => {
  it("has a valid core manifest owned by the Chief of Staff", () => {
    const m = moduleManifestSchema.parse(mod.manifest);
    expect(m.id).toBe("onboarding");
    expect(m.agent).toBe("chief_of_staff");
    expect(m.tier).toBe("core");
    expect(m.level).toBe(1);
  });

  it("names tools onboarding_<verb>_<noun> and jobs onboarding.<name>", () => {
    expect(mod.tools.map((t) => t.name)).toEqual(["onboarding_get_state", "onboarding_record_answer", "onboarding_save_brand_file"]);
    for (const j of mod.jobs) expect(j.id).toMatch(/^onboarding\.[a-z-]+$/);
    expect(Object.values(ONBOARDING_JOBS).sort()).toEqual(mod.jobs.map((j) => j.id).sort());
  });

  it("ships the skills its LLM jobs use, without brand literals", () => {
    for (const j of mod.jobs) {
      if (j.kind !== "llm") continue;
      const file = join(mod.skillsDir!, j.skill, "SKILL.md");
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toMatch(/^---\nname: /);
      expect(text).not.toMatch(/Examplebrand/i);
    }
  });

  it("skill names don't clash with other modules' skills (the plugin shares one namespace)", () => {
    const modulesDir = join(import.meta.dirname, "..", "..");
    const others = readdirSync(modulesDir)
      .filter((m) => m !== "onboarding" && existsSync(join(modulesDir, m, "skills")))
      .flatMap((m) => readdirSync(join(modulesDir, m, "skills")));
    for (const skill of readdirSync(mod.skillsDir!)) expect(others).not.toContain(skill);
  });

  it("only allows MCP tools that exist, and keeps untrusted-input jobs tool-less", () => {
    // Tools from other modules the jobs may use when those modules are installed.
    const names = new Set([...mod.tools.map((t) => `mcp__attentionos__${t.name}`), "mcp__attentionos__knowledge_search"]);
    for (const j of mod.jobs) {
      if (j.kind !== "llm") continue;
      for (const t of j.allowedTools.filter((x) => x.startsWith("mcp__"))) expect(names.has(t)).toBe(true);
      expect(j.onOutput).toBeTypeOf("function");
    }
    const byId = Object.fromEntries(mod.jobs.map((j) => [j.id, j]));
    for (const id of ["onboarding.analyze-site", "onboarding.voice-profile"]) {
      const j = byId[id]!;
      expect(j.kind === "llm" && j.toolless && j.allowedTools.length === 0).toBe(true);
    }
    // The web-reading job may search and fetch, but never touch files or write anything.
    const scout = byId["onboarding.suggest-competitors"]!;
    expect(scout.kind === "llm" && scout.allowedTools).toEqual(["WebSearch", "WebFetch"]);
  });

  it("validates tool inputs: numbers in answers need a source", () => {
    const record = mod.tools.find((t) => t.name === "onboarding_record_answer")!;
    expect(record.input.safeParse({ kind: "proof", text: "Doubled booked calls", numbers: [{ value: "2x", label: "calls", source: "owner" }] }).success).toBe(true);
    expect(record.input.safeParse({ kind: "proof", text: "Doubled booked calls", numbers: [{ value: "2x", label: "calls" }] }).success).toBe(false);
    expect(record.input.safeParse({ kind: "proof", text: "Doubled booked calls", numbers: [{ value: "2x", label: "calls", source: "" }] }).success).toBe(false);
  });
});

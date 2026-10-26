import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseConfig, type ModuleDefinition, type ModuleManifest } from "@attentionos/core";
import { checkModuleDependencies, importOptional, registerBuiltins, isModuleEnabled, orderByDependencies, resolveModuleSet, type ModuleListing } from "../src/index.ts";

function manifest(id: string, extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id, name: id[0]!.toUpperCase() + id.slice(1), description: "", agent: "analyst", tier: "default", level: 1,
    dependsOn: [], requiredProviders: [], optionalProviders: [], schedules: {}, requiresAcknowledgement: [], ...extra,
  };
}
const def = (m: ModuleManifest, extra: Partial<ModuleDefinition> = {}): ModuleDefinition => ({ manifest: m, jobs: [], tools: [], ...extra });
const listing = (d: ModuleDefinition): ModuleListing => ({ id: d.manifest.id, package: `@attentionos/module-${d.manifest.id}`, status: "available", definition: d });

describe("module enablement", () => {
  it("keeps core on, default on unless disabled, opt-in off unless listed", () => {
    const cfg = parseConfig({ modules: { publishing: { enabled: false }, carousels: {} } });
    expect(isModuleEnabled(manifest("research", { tier: "core" }), parseConfig({ modules: { research: { enabled: false } } }))).toBe(true);
    expect(isModuleEnabled(manifest("publishing"), cfg)).toBe(false);
    expect(isModuleEnabled(manifest("community"), cfg)).toBe(true);
    expect(isModuleEnabled(manifest("carousels", { tier: "opt-in" }), cfg)).toBe(true);
    expect(isModuleEnabled(manifest("carousels", { tier: "opt-in" }), parseConfig({}))).toBe(false);
  });

  it("reports missing dependencies", () => {
    const problems = checkModuleDependencies([manifest("community", { dependsOn: ["publishing"] }), manifest("research")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/needs the publishing module/);
  });

  it("orders modules after their dependencies and detects loops", () => {
    const a = def(manifest("community", { dependsOn: ["publishing"] }));
    const b = def(manifest("publishing", { dependsOn: ["scripting"] }));
    const c = def(manifest("scripting"));
    expect(orderByDependencies([a, b, c]).map((d) => d.manifest.id)).toEqual(["scripting", "publishing", "community"]);
    const loop1 = def(manifest("aa", { dependsOn: ["bb"] }));
    const loop2 = def(manifest("bb", { dependsOn: ["aa"] }));
    expect(() => orderByDependencies([loop1, loop2])).toThrow(/loop/);
  });

  it("resolves a set: dependencies, acknowledgements, settings and duplicate tools", () => {
    const tool = { name: "x_tool", description: "", input: z.object({}), handler: async () => null };
    const listings: ModuleListing[] = [
      listing(def(manifest("publishing"), { tools: [tool] })),
      listing(def(manifest("community", { dependsOn: ["publishing"] }))),
      listing(def(manifest("carousels", { tier: "opt-in", requiresAcknowledgement: ["remotionLicense"] }))),
      listing(def(manifest("learn"), { settingsSchema: z.object({ minN: z.number().int().min(3) }) })),
      listing(def(manifest("ops"), { tools: [tool] })),
      { id: "editing", package: "@attentionos/module-editing", status: "not_installed", error: "not installed" },
      { id: "custom", package: "@attentionos/module-custom", status: "failed", error: "boom" },
    ];
    const res = resolveModuleSet(listings, parseConfig({ modules: { publishing: { enabled: false }, carousels: {}, learn: { settings: { minN: 1 } }, editing: {}, custom: {} } }));
    const errors = res.problems.filter((p) => p.severity === "error").map((p) => p.moduleId).sort();
    expect(errors).toEqual(["custom", "learn"]);
    // On only by default, so it waits for publishing instead of stopping AttentionOS.
    expect(res.problems.find((p) => p.moduleId === "community")).toMatchObject({ severity: "warning", message: "Community stays off until publishing is on." });
    expect(res.problems.find((p) => p.moduleId === "editing")?.severity).toBe("warning");
    // A missing acknowledgement keeps only that module off.
    expect(res.problems.find((p) => p.moduleId === "carousels")?.severity).toBe("warning");
    expect(res.modules.map((m) => m.manifest.id)).toEqual(["ops"]);

    // Switched on in the config, a missing dependency is still an error.
    const explicit = resolveModuleSet(listings.slice(0, 2), parseConfig({ modules: { publishing: { enabled: false }, community: { enabled: true } } }));
    expect(explicit.problems.find((p) => p.moduleId === "community")?.severity).toBe("error");

    const dup = resolveModuleSet(listings.slice(0, 1).concat(listings[4]!), parseConfig({}));
    expect(dup.problems.some((p) => /defined by both/.test(p.message))).toBe(true);
  });

  it("prefers the built-in registry over name resolution", async () => {
    registerBuiltins({ "@attentionos/module-zz-builtin": async () => ({ default: { marker: 1 } }) });
    expect(await importOptional("@attentionos/module-zz-builtin", { engineRoot: null })).toMatchObject({ ok: true, from: "builtin", module: { default: { marker: 1 } } });
    registerBuiltins({ "@attentionos/module-zz-broken": async () => { throw new Error("bad bundle"); } });
    expect(await importOptional("@attentionos/module-zz-broken", { engineRoot: null })).toMatchObject({ ok: false, reason: "failed", error: "bad bundle" });
  });

  it("treats missing packages as not installed", async () => {
    const res = await importOptional("@attentionos/module-does-not-exist", { engineRoot: null });
    expect(res).toMatchObject({ ok: false, reason: "not_installed" });
  });
});

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { moduleManifestSchema, type AttentionOSConfig, type ModuleDefinition, type ModuleManifest } from "@attentionos/core";
import { describeIssues, WorkspaceError } from "./errors.ts";
import { builtinModuleIds } from "./builtins.ts";
import { findEngineRoot } from "./paths.ts";
import { importOptional, type ImportSearch } from "./resolve.ts";

/** Modules shipped with the engine. Each is the package `@attentionos/module-<id>`. */
export const KNOWN_MODULES = ["research", "strategy", "scripting", "editing", "carousels", "publishing", "trial-reels", "community", "ops", "learn"] as const;

export type ModuleListing = {
  id: string;
  package: string;
  status: "available" | "not_installed" | "failed";
  definition?: ModuleDefinition;
  error?: string;
};

export type ModuleProblem = { moduleId: string; severity: "error" | "warning"; message: string; fix?: string };

export type ModuleResolution = {
  /** Enabled, installed and dependency-checked, ordered so dependencies come first. */
  modules: ModuleDefinition[];
  listings: ModuleListing[];
  problems: ModuleProblem[];
};

export const modulePackage = (id: string) => `@attentionos/module-${id}`;

function validateDefinition(value: unknown, id: string): ModuleDefinition {
  const def = (value as { default?: unknown })?.default ?? value;
  if (!def || typeof def !== "object") throw new Error(`${modulePackage(id)} has no default export`);
  const d = def as Partial<ModuleDefinition>;
  const manifest = moduleManifestSchema.safeParse(d.manifest);
  if (!manifest.success) throw new Error(`${modulePackage(id)} has an invalid manifest: ${describeIssues(manifest.error.issues)}`);
  if (manifest.data.id !== id) throw new Error(`${modulePackage(id)} declares id "${manifest.data.id}"`);
  if (!Array.isArray(d.jobs) || !Array.isArray(d.tools)) throw new Error(`${modulePackage(id)} must export jobs and tools arrays`);
  return { ...(d as ModuleDefinition), manifest: manifest.data };
}

/** Module ids worth trying: the known list, folders in the engine checkout, and anything named in the config. */
function candidateIds(config?: AttentionOSConfig, engineRoot?: string | null): string[] {
  const ids = new Set<string>([...KNOWN_MODULES, ...builtinModuleIds()]);
  const root = engineRoot === undefined ? findEngineRoot() : engineRoot;
  if (root && existsSync(join(root, "modules"))) {
    for (const entry of readdirSync(join(root, "modules"), { withFileTypes: true })) if (entry.isDirectory()) ids.add(entry.name);
  }
  for (const id of Object.keys(config?.modules ?? {})) ids.add(id);
  return [...ids].filter((id) => /^[a-z][a-z0-9-]{1,31}$/.test(id)).sort();
}

export async function listAllModules(opts: { config?: AttentionOSConfig; search?: ImportSearch } = {}): Promise<ModuleListing[]> {
  const ids = candidateIds(opts.config, opts.search?.engineRoot);
  return Promise.all(
    ids.map(async (id): Promise<ModuleListing> => {
      const pkg = modulePackage(id);
      const res = await importOptional(pkg, opts.search);
      if (!res.ok) return { id, package: pkg, status: res.reason, error: res.error };
      try {
        return { id, package: pkg, status: "available", definition: validateDefinition(res.module, id) };
      } catch (err) {
        return { id, package: pkg, status: "failed", error: (err as Error).message };
      }
    }),
  );
}

/** Whether the config turns a module on. Core modules are always on; opt-in modules must be listed in config. */
export function isModuleEnabled(manifest: ModuleManifest, config: AttentionOSConfig): boolean {
  const toggle = config.modules[manifest.id];
  if (manifest.tier === "core") return true;
  if (manifest.tier === "opt-in") return Boolean(toggle?.enabled);
  return toggle?.enabled ?? true;
}

/** Pure dependency check over the enabled set. Returns one problem per missing dependency. */
export function checkModuleDependencies(enabled: ModuleManifest[]): ModuleProblem[] {
  const ids = new Set(enabled.map((m) => m.id));
  const problems: ModuleProblem[] = [];
  for (const m of enabled) {
    for (const dep of m.dependsOn) {
      if (!ids.has(dep)) {
        problems.push({
          moduleId: m.id,
          severity: "error",
          message: `The ${m.name} module needs the ${dep} module, which is turned off or not installed.`,
          fix: `Turn on "${dep}" in config/attentionos.config.ts (modules.${dep}.enabled = true) or turn off "${m.id}".`,
        });
      }
    }
  }
  return problems;
}

/** Orders modules so each comes after the modules it depends on (stable by id otherwise). */
export function orderByDependencies(defs: ModuleDefinition[]): ModuleDefinition[] {
  const byId = new Map(defs.map((d) => [d.manifest.id, d]));
  const out: ModuleDefinition[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (d: ModuleDefinition, trail: string[]) => {
    const s = state.get(d.manifest.id);
    if (s === "done") return;
    if (s === "visiting") throw new WorkspaceError(`Modules depend on each other in a loop: ${[...trail, d.manifest.id].join(" → ")}`, undefined, "module");
    state.set(d.manifest.id, "visiting");
    for (const dep of [...d.manifest.dependsOn].sort()) {
      const target = byId.get(dep);
      if (target) visit(target, [...trail, d.manifest.id]);
    }
    state.set(d.manifest.id, "done");
    out.push(d);
  };
  for (const d of [...defs].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) visit(d, []);
  return out;
}

export function resolveModuleSet(listings: ModuleListing[], config: AttentionOSConfig): ModuleResolution {
  const problems: ModuleProblem[] = [];
  const enabled: ModuleDefinition[] = [];
  for (const l of listings) {
    const toggle = config.modules[l.id];
    if (!l.definition) {
      if (l.status === "failed") {
        problems.push({
          moduleId: l.id,
          severity: toggle?.enabled ? "error" : "warning",
          message: `The ${l.id} module failed to load: ${l.error}`,
          fix: "Reinstall attentionos, or turn the module off.",
        });
      } else if (toggle?.enabled) {
        // Missing packages never stop the CLI: other modules keep working, and anything that depends on this one
        // is reported by the dependency check below.
        problems.push({
          moduleId: l.id,
          severity: "warning",
          message: `The ${l.id} module is turned on but not installed, so its jobs and tools are unavailable.`,
          fix: `Install ${l.package}, or set modules.${l.id}.enabled = false.`,
        });
      }
      continue;
    }
    const m = l.definition.manifest;
    if (m.tier === "core" && toggle && !toggle.enabled) {
      problems.push({ moduleId: m.id, severity: "warning", message: `${m.name} is a core module and stays on.`, fix: `Remove modules.${m.id}.enabled = false from your config.` });
    }
    if (!isModuleEnabled(m, config)) continue;
    const missingAck = m.requiresAcknowledgement.filter((k) => !(config.acknowledgements as Record<string, boolean>)[k]);
    if (missingAck.length) {
      // A missing acknowledgement keeps just this module off; everything else keeps working.
      problems.push({
        moduleId: m.id,
        severity: "warning",
        message: `${m.name} stays off until you read and accept a notice (${missingAck.join(", ")}).`,
        fix: `Read docs/notices.md, then set acknowledgements.${missingAck[0]} = true in config/attentionos.config.ts.`,
      });
      continue;
    }
    if (l.definition.settingsSchema) {
      const parsed = l.definition.settingsSchema.safeParse(toggle?.settings ?? {});
      if (!parsed.success) {
        problems.push({
          moduleId: m.id,
          severity: "error",
          message: `Settings for ${m.name} are invalid: ${describeIssues(parsed.error.issues)}`,
          fix: `Fix modules.${m.id}.settings in config/attentionos.config.ts.`,
        });
        continue;
      }
    }
    enabled.push(l.definition);
  }

  // A module that's on only by default (not switched on in the config) waits for the modules it needs, instead of
  // stopping AttentionOS: e.g. trial reels stay off until publishing is on. One the owner turned on still errors.
  for (let changed = true; changed; ) {
    changed = false;
    const ids = new Set(enabled.map((d) => d.manifest.id));
    for (const d of [...enabled]) {
      const m = d.manifest;
      const missing = m.dependsOn.filter((dep) => !ids.has(dep));
      if (!missing.length || m.tier !== "default" || config.modules[m.id]?.enabled !== undefined) continue;
      enabled.splice(enabled.indexOf(d), 1);
      changed = true;
      problems.push({
        moduleId: m.id,
        severity: "warning",
        message: `${m.name} stays off until ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} on.`,
        fix: `Turn on ${missing.map((dep) => `modules.${dep}.enabled`).join(" and ")} in config/attentionos.config.ts.`,
      });
    }
  }
  problems.push(...checkModuleDependencies(enabled.map((d) => d.manifest)));

  const tools = new Map<string, string>();
  const jobs = new Map<string, string>();
  for (const d of enabled) {
    for (const t of d.tools) {
      const owner = tools.get(t.name);
      if (owner) problems.push({ moduleId: d.manifest.id, severity: "error", message: `Tool ${t.name} is defined by both ${owner} and ${d.manifest.id}.` });
      tools.set(t.name, d.manifest.id);
    }
    for (const j of d.jobs) {
      const owner = jobs.get(j.id);
      if (owner) problems.push({ moduleId: d.manifest.id, severity: "error", message: `Job ${j.id} is defined by both ${owner} and ${d.manifest.id}.` });
      jobs.set(j.id, d.manifest.id);
    }
  }

  const broken = new Set(problems.filter((p) => p.severity === "error").map((p) => p.moduleId));
  return { modules: orderByDependencies(enabled.filter((d) => !broken.has(d.manifest.id))), listings, problems };
}

export async function resolveModules(config: AttentionOSConfig, opts: { search?: ImportSearch } = {}): Promise<ModuleResolution> {
  return resolveModuleSet(await listAllModules({ config, search: opts.search }), config);
}

/** Enabled, dependency-checked module definitions. Throws a plain-language WorkspaceError on any error. */
export async function loadModules(config: AttentionOSConfig, opts: { search?: ImportSearch } = {}): Promise<ModuleDefinition[]> {
  const res = await resolveModules(config, opts);
  const errors = res.problems.filter((p) => p.severity === "error");
  if (errors.length) {
    throw new WorkspaceError(errors.map((e) => e.message).join("\n"), errors.find((e) => e.fix)?.fix, "module");
  }
  return res.modules;
}

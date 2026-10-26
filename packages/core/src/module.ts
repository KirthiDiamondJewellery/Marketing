import { z } from "zod";
import { AGENT_KEYS } from "./types.ts";
import type { JobDefinition } from "./jobs.ts";
import type { ToolDefinition } from "./tools.ts";

/** `modules/<id>/module.json`: static metadata, readable without executing code (plugin builder, docs, doctor). */
export const moduleManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  name: z.string(),
  description: z.string(),
  agent: z.enum(AGENT_KEYS),
  /** core = always on; default = on after setup; opt-in = user enables it. */
  tier: z.enum(["core", "default", "opt-in"]),
  /** Setup level that unlocks it. */
  level: z.number().int().min(1).max(4),
  dependsOn: z.array(z.string()).default([]),
  /** Provider kinds this module needs, e.g. ["publisher", "inbox"]. */
  requiredProviders: z.array(z.string()).default([]),
  optionalProviders: z.array(z.string()).default([]),
  /** job id → default cron (workspace timezone). */
  schedules: z.record(z.string(), z.string()).default({}),
  /** Opt-in notices the user must acknowledge (keys of config.acknowledgements). */
  requiresAcknowledgement: z.array(z.string()).default([]),
});
export type ModuleManifest = z.output<typeof moduleManifestSchema>;

/** What a module package exports by default (`modules/<id>/src/index.ts`). */
export type ModuleDefinition = {
  manifest: ModuleManifest;
  /** Zod schema for `config.modules[<id>].settings`. */
  settingsSchema?: z.ZodType;
  jobs: JobDefinition[];
  tools: ToolDefinition[];
  /** Absolute path to SQL migrations owned by this module (sorted by filename timestamp across all modules). */
  migrationsDir?: string;
  /** Absolute path to Claude Code skills (each `<skill>/SKILL.md`). */
  skillsDir?: string;
};

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  const seen = new Set<string>();
  for (const t of def.tools) {
    if (seen.has(t.name)) throw new Error(`module ${def.manifest.id}: duplicate tool ${t.name}`);
    seen.add(t.name);
  }
  return def;
}

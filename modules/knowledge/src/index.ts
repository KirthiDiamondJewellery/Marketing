import { readFileSync } from "node:fs";
import { defineModule, moduleManifestSchema } from "@attentionos/core";
import { KNOWLEDGE_JOBS } from "./jobs.ts";
import { knowledgeSettingsSchema } from "./settings.ts";
import { KNOWLEDGE_TOOLS } from "./tools.ts";

const manifest = moduleManifestSchema.parse(JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")));

/** The knowledge table itself is engine schema (packages/db/migrations), so this module ships no migrations. */
export default defineModule({
  manifest,
  settingsSchema: knowledgeSettingsSchema,
  jobs: KNOWLEDGE_JOBS,
  tools: KNOWLEDGE_TOOLS,
});

export { describeIndexRun, indexPathJob, indexWorkspaceJob } from "./jobs.ts";
export { knowledgeSearchTool, knowledgeStatusTool, KNOWLEDGE_TOOLS } from "./tools.ts";
export { knowledgeSettings, knowledgeSettingsSchema, type KnowledgeSettings } from "./settings.ts";

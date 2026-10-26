import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema } from "@attentionos/core";
import { batchDayJob, dailyBriefJob, draftBriefJob } from "./jobs/brief.ts";
import { strategySettingsSchema } from "./settings.ts";
import { STRATEGY_TOOLS } from "./tools.ts";

const manifest = moduleManifestSchema.parse(JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")));

export default defineModule({
  manifest,
  settingsSchema: strategySettingsSchema,
  jobs: [dailyBriefJob, batchDayJob, draftBriefJob],
  tools: STRATEGY_TOOLS,
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

export { planSlate, DEFAULT_TEMPLATES, DEFAULT_CTA_BY_STAGE, type PlannerInput, type SlateItem, type PlanResult } from "./planner.ts";
export { parsePillars, appendRejectedConcept, loadPresetDefaults, inferLaneKinds, DEFAULT_STORY_STRUCTURES, type Lane, type Pillars, type IdeaKind } from "./pillars.ts";
export { runBrief, buildPlannerInput, summarise, type BriefResult } from "./jobs/brief.ts";
export { strategySettings, strategySettingsSchema } from "./settings.ts";
export { pickScriptTargets, queueScriptsForBrief, cancelQueuedScripts, autoScriptsQueued, isFilmable, writeScriptKey, remixSourceOf, WRITE_SCRIPT_JOB, REMIX_READY_JOB, TEARDOWN_PREP_JOB, FILMED_IDEA_KINDS, type ScriptHandoff, type ScriptTarget } from "./script-handoff.ts";
export { rankRemixSources, remixSlots, provenScore, nicheRelevance, nicheWordsFrom, TIER_WEIGHT, type RemixPoolItem, type RankedRemix, type RemixRankOptions } from "./remix.ts";
export { remixPool } from "./repo.ts";

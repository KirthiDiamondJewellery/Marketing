import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema, type JobDefinition } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { captionsJob, classifyHooksJob, harvestHooksJob, remixReadyJob, textPostsJob } from "./jobs/other-jobs.ts";
import { writeScriptJob } from "./jobs/write-script.ts";
import { scriptingSettingsSchema } from "./settings.ts";
import { scriptingTools } from "./tools/index.ts";

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  settingsSchema: scriptingSettingsSchema,
  jobs: [writeScriptJob, captionsJob, textPostsJob, harvestHooksJob, classifyHooksJob, remixReadyJob] as unknown as JobDefinition[],
  tools: scriptingTools,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

export { scriptingSettingsSchema, scriptingSettings, type ScriptingSettings } from "./settings.ts";
export { HOOK_PATTERNS, HOOK_PATTERN_IDS, UNCLASSIFIED, getPattern, preClassifyHook, type HookPattern } from "./taxonomy.ts";
export { classificationOutputSchema, classificationEnvelopeSchema, validateClassification, sharedRun } from "./classifier.ts";
export { selectHooks, loadLearnWeights, seededRandom, type HookCandidate, type HookPick, type LearnWeightsFn } from "./select.ts";
export { reviseUntilValid, revisionFeedback, parseScriptPackage, extractJson, type RevisionOutcome } from "./revision.ts";
export {
  BRAND_PATHS, buildScriptRules, getClaimSources, getContentBrief, listHooks, pickHooks, reserveKeyword, saveScript, validateForContent,
  type ReserveResult, type SaveScriptInput, type SaveScriptResult, type HookView,
} from "./service.ts";
export { harvestOwnHooks, harvestCompetitorHooks, applyCompetitorDecay, applyClassifications } from "./hooks.ts";
export { saveCaptions, saveTextPosts } from "./copy.ts";
export { writeScriptJob, writeScriptInput, reviseRequestSchema, runWriteScript, type ReviseRequest, type ScriptModel, type WriteScriptOutcome } from "./jobs/write-script.ts";
export { captionsJob, textPostsJob, harvestHooksJob, classifyHooksJob, remixReadyJob } from "./jobs/other-jobs.ts";
export {
  findRemixSources, loadRemixSource, ownWinners, provenScore, remixOf, remixRulesFor, remixSourceId, remixView,
  startWaitingScript, topicMatch, useRemixSource, REMIX_READY_JOB, TEARDOWN_PREP_JOB,
  type Blueprint, type OwnWinner, type RemixCandidate, type RemixSource, type RemixView,
} from "./remix.ts";
export { REMIX_RULES, writeScriptPrompt, writeScriptAgentPrompt } from "./prompts.ts";
export { writePacket, skillBody, type WritePacket } from "./packet.ts";
export { applyPatch, completePackage } from "./package-edit.ts";

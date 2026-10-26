import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema, type JobDefinition } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { productionJobs } from "./jobs/index.ts";
import { productionSettingsSchema } from "./settings.ts";
import { productionTools } from "./tools/index.ts";

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  settingsSchema: productionSettingsSchema,
  jobs: productionJobs as unknown as JobDefinition[],
  tools: productionTools,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
});

export { JOB_IDS, productionJobs, matchUploadJob, advanceJob, scheduleApprovedJob } from "./jobs/index.ts";
export { productionSettingsSchema, productionSettings, loadProductionSettings, LIVE_SETTINGS_KEY, type ProductionSettings } from "./settings.ts";
export { words, contentTokens, tokenSetScore, hookScore, scoreScript, rankScripts, clearWinner, confidenceLabel, type ScriptCandidate, type MatchResult } from "./match.ts";
export { linkUpload, enqueuePrep, cancelEdit, kickAdvance, getUpload, insertUpload, updateUpload, getRelease, upsertRelease, type UploadRow, type ReleaseRow, type ReleaseSlot, type ReleaseOutcome, type LinkResult } from "./repo.ts";
export { runMatchUpload, scriptCandidates } from "./match-upload.ts";
export { runAdvance, enqueueSchedule } from "./advance.ts";
export { runScheduleApproved, proposeSlots, ensureProposal, releasePlatforms, mayRelease, describeOutcomes, latestRenderApproval } from "./release.ts";
export { productionTools, productionQueue } from "./tools/index.ts";

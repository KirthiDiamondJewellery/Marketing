import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema, type JobDefinition } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { jobs } from "./jobs/index.ts";
import { trialReelsSettingsSchema } from "./settings.ts";
import { tools } from "./tools/index.ts";

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  settingsSchema: trialReelsSettingsSchema,
  jobs: jobs as unknown as JobDefinition[],
  tools,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

export { DAILY_CAP, DEFAULT_SPEEDS, graduationStrategy, trialReelsSettings, trialReelsSettingsSchema, type TrialReelsSettings } from "./settings.ts";
export { addDays, busiest24h, cleanHashtags, fitUnderCap, foreignTitleWords, hashtagsIn, interleave, LAYOUTS, localDate, slots, slugFor, splitTotal, zonedToUtc, type Layout } from "./plan.ts";
export {
  BatchError, CLEAN_UPLOAD_PURPOSE, createBatch, getBatch, ledger, postingPlan, recentBatches, trialSources,
  type BatchRow, type BatchSource, type BatchStatus, type BatchVariant, type LedgerRow, type NewBatch, type NewReel, type PlannedPost, type TrialSource, type TrialWs,
} from "./repo.ts";
export { batchView, cancelBatch, JOB_IDS, makeBatch, scheduleBatch, SUBJECT, workDirFor, type ScheduleBatchResult } from "./service.ts";
export { jobs } from "./jobs/index.ts";
export { tools } from "./tools/index.ts";

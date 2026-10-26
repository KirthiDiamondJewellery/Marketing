import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema } from "@attentionos/core";
import { competitorScanJob } from "./jobs/competitorScan.ts";
import { ingestTranscriptJob } from "./jobs/ingestTranscript.ts";
import { ownSyncJob } from "./jobs/ownSync.ts";
import { teardownJob, teardownPrepJob } from "./jobs/teardown.ts";
import { trendRadarJob } from "./jobs/trendRadar.ts";
import { trendWriterJob } from "./jobs/trendWriter.ts";
import { researchSettingsSchema } from "./settings.ts";
import { addTrackedCreatorTool, listTrackedCreatorsTool, removeTrackedCreatorTool, researchStatusTool } from "./tools/creators.ts";
import { getExternalPostTool, listOutliersTool, listTeardownsTool, requestTeardownTool } from "./tools/library.ts";
import { dismissTrendTool, listTrendsTool, shortlistTrendTool } from "./tools/trends.ts";

const manifest = moduleManifestSchema.parse(JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")));

export default defineModule({
  manifest,
  settingsSchema: researchSettingsSchema,
  jobs: [
    ownSyncJob, competitorScanJob, trendRadarJob, trendWriterJob,
    teardownPrepJob, teardownJob, ingestTranscriptJob,
  ],
  tools: [
    listOutliersTool, getExternalPostTool, listTrendsTool, shortlistTrendTool, dismissTrendTool,
    listTrackedCreatorsTool, addTrackedCreatorTool, removeTrackedCreatorTool, researchStatusTool,
    requestTeardownTool, listTeardownsTool,
  ],
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

// Shared building blocks for strategy and learn (and the runner's hand-off wiring).
export { researchSettings, researchSettingsSchema, type ResearchSettings } from "./settings.ts";
export {
  transcriptionRequestSchema, ingestTranscriptInputSchema, REPLY_TO,
  type TranscriptionRequest, type IngestTranscriptInput,
} from "./handoff.ts";
export { syncOwnMetrics, collapseTrialVariants, insertMetricsSnapshot, SNAPSHOT_LABELS, type SnapshotLabel, type OwnSyncResult } from "./repo/ownPosts.ts";
export { listOutliers, getExternalPost, type StoredExternalPost } from "./repo/externalPosts.ts";
export { listTrends, getTrend, setTrendStatus, type StoredTrend } from "./repo/trends.ts";
export { listTrackedCreators, syncTrackedCreators, type TrackedCreator } from "./repo/creators.ts";
export { queueNotification, alertOnce, enqueueRun, recordCost, spendSince, periodStart, fmtUsd, type CostCategory } from "./lib/ops.ts";
export { num, iso, count } from "./lib/db.ts";
export { runCompetitorScan, rescoreCreator, scrapingBudgetUsed } from "./jobs/competitorScan.ts";
export { runTrendRadar } from "./jobs/trendRadar.ts";
export { saveTrendKit } from "./jobs/trendWriter.ts";
export { checkTrendKit, trendKitSchema, trendWriterOutputSchema, type TrendKit } from "./validate/trendKit.ts";
export { saveTeardown, styleFingerprint, prepareTeardown, latestBlueprint, type Continuation } from "./jobs/teardown.ts";
export {
  checkBlueprint, quotedFrom, remixBlueprintSchema, blueprintBeatSchema, BLUEPRINT_FORMATS, BLUEPRINT_BEAT_ROLES,
  type RemixBlueprint, type StoredBlueprint,
} from "./validate/blueprint.ts";
export { ingestTranscript } from "./jobs/ingestTranscript.ts";

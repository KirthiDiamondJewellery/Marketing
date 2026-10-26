import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema } from "@attentionos/core";
import { costWatchJob, weeklyBriefingJob, weeklyBriefingProseJob } from "./briefing.ts";
import { captureSnapshotsJob } from "./jobs/captureSnapshots.ts";
import { captureFollowersJob, funnelImportJob, siteWebhookJob } from "./jobs/ingest.ts";
import { postMortemJob, postMortemScanJob } from "./postMortems.ts";
import { learnSettingsSchema } from "./settings.ts";
import { attributionJob, LEARN_TOOLS } from "./tools.ts";

const manifest = moduleManifestSchema.parse(JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")));

export default defineModule({
  manifest,
  settingsSchema: learnSettingsSchema,
  jobs: [
    captureSnapshotsJob, captureFollowersJob, attributionJob, postMortemScanJob, postMortemJob, weeklyBriefingJob, weeklyBriefingProseJob,
    costWatchJob, siteWebhookJob, funnelImportJob,
  ],
  tools: LEARN_TOOLS,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

export { getWeights, getFeatureWeights, runAttribution, loadFeatureStats, type Weights } from "./attribution.ts";
export { computeOwnScores, scoreOwnPosts, type OwnPostScore } from "./metrics.ts";
export { captureDueSnapshots } from "./jobs/captureSnapshots.ts";
export { dueSnapshots, nextSnapshotAt, SNAPSHOT_SCHEDULE, SCHEDULED_LABELS } from "./schedule.ts";
export { northStar, type NorthStarReading } from "./northStar.ts";
export { buildWeeklyBriefing, costWatch, type WeeklyBriefing } from "./briefing.ts";
export { findPostMortemCandidates, scanPostMortems, savePostMortem } from "./postMortems.ts";
export { learnSettings, learnSettingsSchema } from "./settings.ts";
export { captureFollowers, followerGrowth, canListAccountStats, type AccountStat, type AccountStatsCapable } from "./analytics/accounts.ts";
export { recordScanFollowers, refreshScanFollowers, foldScanAccounts, SCAN_PROVIDER, SCAN_REFRESH_DAYS, type ScanRefreshResult } from "./followers.ts";
export { normalizeSiteEvent, siteEvents, importFunnelCsvs, readCsv } from "./jobs/ingest.ts";
export { goalPacingReport, measure, NORTH_STAR_METRICS, type GoalPacing } from "./northStar.ts";
export * from "./analytics/index.ts";

import { defineModule, moduleManifestSchema } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { analyzeSiteJob } from "./jobs/analyze-site.ts";
import { importOwnPostsJob } from "./jobs/import-own-posts.ts";
import { interviewJob } from "./jobs/interview.ts";
import { suggestCompetitorsJob } from "./jobs/suggest-competitors.ts";
import { voiceProfileJob } from "./jobs/voice-profile.ts";
import { voiceReadyJob } from "./jobs/voice-ready.ts";
import { SKILLS_DIR } from "./lib/context.ts";
import { onboardingTools } from "./tools/index.ts";

export * from "./lib/state.ts";
export * from "./schemas.ts";
export * from "./lib/handles.ts";
export { validateBrandFile, writeBrandFile, readBrandFile, resolveBrandFile, normalizeBrandFile, BrandFileError, WRITABLE_BRAND_FILES } from "./lib/brand-files.ts";
export { readSite, htmlToText, normalizeSiteUrl, isPublicHttpUrl } from "./lib/web.ts";
export { interviewSession } from "./jobs/interview.ts";
export { importOwnPosts, type ImportOutcome } from "./jobs/import-own-posts.ts";
export { pickForTranscription, externalFromSnapshot, voiceSourcePosts, listOwnPosts, OWN_POST_LIMIT, OWN_TRANSCRIBE_LIMIT } from "./lib/own-posts.ts";

/** Job ids Studio's setup wizard enqueues. */
export const ONBOARDING_JOBS = {
  analyzeSite: analyzeSiteJob.id,
  importOwnPosts: importOwnPostsJob.id,
  voiceReady: voiceReadyJob.id,
  voiceProfile: voiceProfileJob.id,
  interview: interviewJob.id,
  suggestCompetitors: suggestCompetitorsJob.id,
} as const;

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  jobs: [analyzeSiteJob, importOwnPostsJob, voiceReadyJob, voiceProfileJob, interviewJob, suggestCompetitorsJob],
  tools: onboardingTools,
  skillsDir: SKILLS_DIR,
});

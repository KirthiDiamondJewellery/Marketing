import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema, type JobDefinition } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { jobs } from "./jobs/index.ts";
import { publishingSettingsSchema } from "./settings.ts";
import { tools } from "./tools/index.ts";

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  settingsSchema: publishingSettingsSchema,
  jobs: jobs as unknown as JobDefinition[],
  tools: tools as never,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

export { DEFAULT_CADENCE, PUBLISHING_SECRETS, publishingSettings, publishingSettingsSchema, type PlatformCadence, type PublishingSettings } from "./settings.ts";
export { buildTrackedUrl, buildUtm, buildUtmContent, createShortLink, postNumberFromUtm, ShortLinkError, type ShortLink, type Utm } from "./lib/links.ts";
export { checkPayload, describeCheck, type PayloadCheckInput } from "./lib/payload.ts";
export { buildWeekManifest, manifestTable, planSlots, postIdempotencyKey, type ManifestEntry, type ManifestInput, type ManifestItem, type WeekManifest } from "./lib/manifest.ts";
export { isKeywordCtaLine, swapKeywordCta, NO_CLICKABLE_LINKS } from "./lib/crosspost.ts";
export { confirmTrialProof, getTrialProof, proofKey, type ProofLock } from "./lib/trial-flow.ts";
export { activity, approvalRequired, autonomyOf, gate, getSetting, latestApproval, notify, setSetting, type GateRequest, type GateResult } from "./lib/gate.ts";
export { linkDestination, trackingFor, type Tracking } from "./lib/tracking.ts";
export { accountsSnapshot, ensurePostNumber, freshAccounts, getPost, loadContent, syncAccounts, type ContentForPost, type PostPayload, type PostRow, type PostStatus } from "./lib/repo.ts";
export {
  applyPublishEvent, cancelPost, crossPost, handOff, nextOpenSlot, notifyAssist, publishDue, schedulePost, scheduleWeek,
  type PublishEventLike, type ScheduleInput, type ScheduleOutcome,
} from "./lib/scheduler.ts";
export { addDays, localDate, localTime, mondayOf, nextMonday, zonedToUtc } from "./lib/time.ts";
export { jobs } from "./jobs/index.ts";
export { tools } from "./tools/index.ts";

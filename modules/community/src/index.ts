import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema, type JobDefinition } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { jobs } from "./jobs/index.ts";
import { communitySettingsSchema } from "./settings.ts";
import { tools } from "./tools/index.ts";

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  settingsSchema: communitySettingsSchema,
  jobs: jobs as unknown as JobDefinition[],
  tools: tools as never,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

export { AUTOMATED_DM_NOTICE, communitySettings, communitySettingsSchema, type CommunitySettings } from "./settings.ts";
export {
  ageTemperature, compileRules, findTemplates, isRealMessage, normalise, prefilterComment, prefilterThread,
  type PrefilterReason, type PrefilterRules, type PrefilterVerdict, type Thread, type ThreadMessage, type ThreadVerdict,
} from "./lib/prefilter.ts";
export { buildClassifyPrompt, checkDraftReply, extractVerdicts, verdictBatchSchema, verdictSchema, type ClassifyItem, type Verdict } from "./lib/classify.ts";
export { checkGuide, slugify, type GuideCheck } from "./lib/guide.ts";
export { handoffLead, upsertContact, type ContactRow, type HandoffResult } from "./lib/leads.ts";
export {
  activateAutomation, activatePending, createKeywordAutomation, ensureKeyword, registerLeadMagnet,
  type AutomationOutcome, type AutomationRow, type CreateAutomationInput, type LeadMagnetRow, type RegisterLeadMagnetInput,
} from "./lib/chain.ts";
export {
  ageItems, applyTriageVerdicts, classifyInput, draftCommentReplies, ingestInboxEvent, itemsNeedingClassification, sendApproved, sendReply, triageInbox,
  CLASSIFY_JOB, type InboxEventLike, type SendOutcome, type TriageRow, type TriageSummary,
} from "./lib/triage.ts";
export { jobs } from "./jobs/index.ts";
export { tools } from "./tools/index.ts";

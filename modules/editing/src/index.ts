import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema, type JobDefinition } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { editingJobs } from "./jobs/index.ts";
import { editingSettingsSchema } from "./settings.ts";
import { editingTools } from "./tools/index.ts";

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  settingsSchema: editingSettingsSchema,
  jobs: editingJobs as unknown as JobDefinition[],
  tools: editingTools,
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

export { editingSettingsSchema, editingSettings, type EditingSettings } from "./settings.ts";
export { prepJob, planJob, renderJob, reviseJob, transcribeJob, reviseInput, planOutput, editingJobs } from "./jobs/index.ts";
export { editingTools } from "./tools/index.ts";
export {
  JOB_IDS, startEdit, runPrep, approveCutList, getPlanContext, savePlan, requestRender, runRender, addRevisionNote, recordRevisionNote,
  revisionSessionId, getEditJobView, getQcReport, outputTranscriptLines, workDir, renderPath, cleanPlan, cleanRenderPath, renderClean,
  type CleanRender, type PrepState, type ApprovalInput,
} from "./service.ts";
export { runTranscribe, transcribeInput, normaliseRequest, type TranscribeInput } from "./transcribe.ts";
export { planAssetIds, resolvePlanAssets, claimLedgerFor, runGate, toPreflightPlan, addSignoff } from "./gates.ts";
export { planDigests, revisionKind, parseRevisionText, spokenHook, type RevisionKind } from "./revisions.ts";
export { getEditJob, type EditJobRow, type EditStatus, type EditNote, type EditPreflightState } from "./repo.ts";
export { planPrompt, revisePrompt } from "./prompts.ts";

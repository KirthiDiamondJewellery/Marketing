import { fileURLToPath } from "node:url";
import { defineModule, moduleManifestSchema, type WorkspaceContext } from "@attentionos/core";
import manifestJson from "../module.json" with { type: "json" };
import { chiefOfStaffJob, pollInboundJob } from "./jobs/inbound.ts";
import { morningBriefJob, writeMorningBriefJob } from "./jobs/morning-brief.ts";
import { dispatchOutboxJob } from "./jobs/outbox.ts";
import { composeSessionSummary } from "./lib/brief.ts";
import { loadBriefData } from "./lib/brief-data.ts";
import { loadMasker } from "./lib/store.ts";
import { opsSettingsSchema } from "./settings.ts";
import { decideApprovalTool, listApprovalsTool } from "./tools/approvals.ts";
import { getMorningBriefTool } from "./tools/brief.ts";
import { processChatTool } from "./tools/chat.ts";
import { sendNotificationTool } from "./tools/notify.ts";
import { setDemoModeTool, setQuietHoursTool } from "./tools/settings.ts";

export { opsSettings, opsSettingsSchema, SETTING_KEYS, type OpsSettings } from "./settings.ts";
export { composeBrief, composeSessionSummary, compactNumber, formatX, type Brief, type BriefData } from "./lib/brief.ts";
export { loadBriefData } from "./lib/brief-data.ts";
export { routeInbound, HELP_TEXT, type Intent } from "./lib/router.ts";
export { parseRef, parseActionId, actionId, normalizeApprovalRef } from "./lib/refs.ts";
export { isQuietHours, quietUntil, mayDeliver, parseQuietInput, type QuietWindow } from "./lib/quiet-hours.ts";
export { alertDecision, alertKey } from "./lib/alerts.ts";
export { enqueueMessage, dispatchOutbox, raiseAlert } from "./lib/outbox.ts";
export { decideApproval, listApprovals, announceNewApprovals, approvalMessage } from "./lib/approvals.ts";
export { processInbound, applyIntent } from "./lib/chat.ts";
export { createMasker, maskPairs, maskText, fakeName, fakeHandle } from "./lib/mask.ts";
export { briefDedupeKey } from "./jobs/morning-brief.ts";

/**
 * What the Claude Code SessionStart hook prints in a workspace (via `attentionos hook session-start`):
 * pending approvals and today's filming, in two or three plain lines.
 */
export async function sessionStartSummary(ws: WorkspaceContext): Promise<string> {
  const [data, masker] = await Promise.all([loadBriefData(ws), loadMasker(ws)]);
  return composeSessionSummary(data, masker.text);
}

export default defineModule({
  manifest: moduleManifestSchema.parse(manifestJson),
  settingsSchema: opsSettingsSchema,
  jobs: [morningBriefJob, writeMorningBriefJob, dispatchOutboxJob, pollInboundJob, chiefOfStaffJob],
  tools: [getMorningBriefTool, listApprovalsTool, decideApprovalTool, sendNotificationTool, setQuietHoursTool, setDemoModeTool, processChatTool],
  skillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
});

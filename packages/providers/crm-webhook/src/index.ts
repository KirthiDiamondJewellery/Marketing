import type { Crm } from "@attentionos/core";
import { createGoHighLevelCrm } from "./gohighlevel.ts";
import { createHubSpotCrm } from "./hubspot.ts";
import { createSheetsCrm } from "./sheets.ts";
import type { CrmCreateOptions } from "./shared.ts";
import { createWebhookCrm } from "./webhook.ts";

export { createGoHighLevelCrm, GHL_API_VERSION, GHL_BASE_URL } from "./gohighlevel.ts";
export { createHubSpotCrm, HUBSPOT_BASE_URL } from "./hubspot.ts";
export { createSheetsCrm } from "./sheets.ts";
export { createWebhookCrm, verifyLeadWebhook } from "./webhook.ts";
export {
  CRM_SECRETS, SIGNATURE_HEADER, TIMESTAMP_HEADER, crmSettings, crmSettingsSchema, leadKey, signBody,
  type CrmCreateOptions, type CrmSettings,
} from "./shared.ts";

/**
 * Picks the CRM adapter from `config.providers.crm`.
 * `lite` returns `undefined`: there is no external CRM and the community module keeps leads in the
 * built-in `contacts` table only.
 */
export function create(opts: CrmCreateOptions): Crm | undefined {
  switch (opts.config.providers.crm) {
    case "webhook": return createWebhookCrm(opts);
    case "sheets": return createSheetsCrm(opts);
    case "gohighlevel": return createGoHighLevelCrm(opts);
    case "hubspot": return createHubSpotCrm(opts);
    case "lite": return undefined;
  }
}

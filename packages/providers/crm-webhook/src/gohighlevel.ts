import { z } from "zod";
import { ProviderError, type Crm, type Lead } from "@attentionos/core";
import { HttpClient } from "@attentionos/provider-shared";
import { CRM_SECRETS, crmSettings, splitName, validateLead, type CrmCreateOptions } from "./shared.ts";

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";

const upsertResponse = z.looseObject({
  new: z.boolean().optional(),
  contact: z.looseObject({ id: z.string() }),
});

const errorBody = z.looseObject({ message: z.union([z.string(), z.array(z.string())]).optional(), statusCode: z.number().optional() });

/**
 * GoHighLevel (LeadConnector API v2) contacts upsert: `POST /contacts/upsert`.
 * Auth: a Private Integration token (`Authorization: Bearer`, scope `contacts.write`) plus the sub-account
 * (location) id. Upsert matches on email/phone per the location's duplicate-contact settings.
 */
export function createGoHighLevelCrm(opts: CrmCreateOptions): Crm {
  const id = "crm-gohighlevel";
  const token = opts.secret(CRM_SECRETS.gohighlevel.token);
  const locationId = opts.secret(CRM_SECRETS.gohighlevel.locationId);
  const settings = crmSettings(opts.config);
  const http = new HttpClient({
    provider: id,
    baseUrl: GHL_BASE_URL,
    headers: () => ({ authorization: `Bearer ${token ?? ""}`, version: GHL_API_VERSION }),
    log: opts.log,
    fetch: opts.fetch,
    sleep: opts.sleep,
    maxRetries: 4,
    describeError: (status, body) => {
      const parsed = errorBody.safeParse(body);
      const msg = parsed.success ? parsed.data.message : undefined;
      return { message: msg ? `GoHighLevel: ${Array.isArray(msg) ? msg.join("; ") : msg}` : `GoHighLevel returned HTTP ${status}` };
    },
  });

  return {
    id,
    async health() {
      if (!token) return { ok: false, detail: "No GoHighLevel token set", fix: `Create a Private Integration (Settings → Private Integrations, scope contacts.write) and add it as ${CRM_SECRETS.gohighlevel.token}` };
      if (!locationId) return { ok: false, detail: "No GoHighLevel location id set", fix: `Add your sub-account id as ${CRM_SECRETS.gohighlevel.locationId}` };
      return { ok: true, detail: "Leads will be added to GoHighLevel contacts" };
    },
    async upsertLead(lead: Lead) {
      if (!token || !locationId) throw new ProviderError(id, "auth", `set ${CRM_SECRETS.gohighlevel.token} and ${CRM_SECRETS.gohighlevel.locationId}`);
      const clean = validateLead(id, lead);
      const tags = [...settings.tags];
      if (clean.keyword) tags.push(`keyword:${clean.keyword.toLowerCase()}`);
      if (clean.temperature) tags.push(clean.temperature);
      const res = await http.request("POST", "/contacts/upsert", {
        body: {
          locationId,
          ...splitName(clean.name),
          name: clean.name,
          email: clean.email,
          phone: clean.phone,
          source: clean.utmContent ? `${clean.source} (${clean.utmContent})` : clean.source,
          tags,
        },
        schema: upsertResponse,
      });
      return { id: res.contact.id };
    },
  };
}

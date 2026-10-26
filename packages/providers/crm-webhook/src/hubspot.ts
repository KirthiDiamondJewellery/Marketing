import { z } from "zod";
import { ProviderError, type Crm, type Lead } from "@attentionos/core";
import { HttpClient } from "@attentionos/provider-shared";
import { CRM_SECRETS, crmSettings, splitName, validateLead, type CrmCreateOptions } from "./shared.ts";

export const HUBSPOT_BASE_URL = "https://api.hubapi.com";

const batchResponse = z.looseObject({
  status: z.string().optional(),
  results: z.array(z.looseObject({ id: z.string() })).min(1),
});
const createResponse = z.looseObject({ id: z.string() });
const errorBody = z.looseObject({ message: z.string().optional(), category: z.string().optional() });

/**
 * HubSpot CRM v3 contacts.
 * - With an email: `POST /crm/v3/objects/contacts/batch/upsert` with `idProperty: "email"` (true upsert).
 * - Without an email (social-only lead): `POST /crm/v3/objects/contacts` (create).
 * Auth: a private app access token (`Authorization: Bearer`, scope `crm.objects.contacts.write`).
 * Custom fields (keyword, utm_content, temperature, handle) are written only when mapped to existing
 * HubSpot property names in `modules.community.settings.crm.hubspot.properties`.
 */
export function createHubSpotCrm(opts: CrmCreateOptions): Crm {
  const id = "crm-hubspot";
  const token = opts.secret(CRM_SECRETS.hubspot.token);
  const settings = crmSettings(opts.config).hubspot;
  const http = new HttpClient({
    provider: id,
    baseUrl: HUBSPOT_BASE_URL,
    headers: () => ({ authorization: `Bearer ${token ?? ""}` }),
    log: opts.log,
    fetch: opts.fetch,
    sleep: opts.sleep,
    maxRetries: 4,
    describeError: (status, body) => {
      const parsed = errorBody.safeParse(body);
      return { message: parsed.success && parsed.data.message ? `HubSpot: ${parsed.data.message}` : `HubSpot returned HTTP ${status}`, vendorCode: parsed.success ? parsed.data.category : undefined };
    },
  });

  function properties(lead: Lead): Record<string, string> {
    const { firstName, lastName } = splitName(lead.name);
    const props: Record<string, string | undefined> = {
      email: lead.email,
      firstname: firstName,
      lastname: lastName,
      phone: lead.phone,
      lifecyclestage: settings.lifecycleStage || undefined,
    };
    const map = settings.properties;
    if (map.keyword && lead.keyword) props[map.keyword] = lead.keyword;
    if (map.utmContent && lead.utmContent) props[map.utmContent] = lead.utmContent;
    if (map.temperature && lead.temperature) props[map.temperature] = lead.temperature;
    if (map.handle && lead.handle) props[map.handle] = lead.handle;
    return Object.fromEntries(Object.entries(props).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0));
  }

  return {
    id,
    async health() {
      if (!token) return { ok: false, detail: "No HubSpot token set", fix: `Create a private app (Settings → Integrations → Private apps, scope crm.objects.contacts.write) and add its token as ${CRM_SECRETS.hubspot.token}` };
      return { ok: true, detail: "Leads will be added to HubSpot contacts" };
    },
    async upsertLead(lead: Lead) {
      if (!token) throw new ProviderError(id, "auth", `set ${CRM_SECRETS.hubspot.token}`);
      const clean = validateLead(id, lead);
      if (clean.email) {
        const res = await http.request("POST", "/crm/v3/objects/contacts/batch/upsert", {
          body: { inputs: [{ idProperty: "email", id: clean.email, properties: properties(clean) }] },
          schema: batchResponse,
        });
        return { id: res.results[0]!.id };
      }
      // Creating isn't idempotent: only retry when HubSpot refused the request (429).
      const res = await http.request("POST", "/crm/v3/objects/contacts", { body: { properties: properties(clean) }, schema: createResponse, retry: "rate_limited" });
      return { id: res.id };
    },
  };
}

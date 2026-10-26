import { z } from "zod";
import { ProviderError, type Crm, type Lead } from "@attentionos/core";
import { HttpClient } from "@attentionos/provider-shared";
import { CRM_SECRETS, leadEvent, leadKey, validateLead, type CrmCreateOptions } from "./shared.ts";

const responseSchema = z.looseObject({
  ok: z.boolean().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  row: z.number().optional(),
  error: z.string().optional(),
});

/**
 * Google Sheets through an Apps Script web app (no Google Cloud project or OAuth needed).
 * Apps Script's `doPost(e)` can't read request headers, so the shared secret travels in the body as `token`.
 * The receiving script (see README) checks the token, appends or updates a row keyed on `id`, and
 * returns `{ "ok": true, "row": <n> }`. Apps Script answers POSTs with a redirect; fetch follows it.
 */
export function createSheetsCrm(opts: CrmCreateOptions): Crm {
  const id = "crm-sheets";
  const url = opts.secret(CRM_SECRETS.sheets.url);
  const token = opts.secret(CRM_SECRETS.sheets.secret);
  const now = opts.now ?? (() => new Date());
  const http = new HttpClient({
    provider: id, baseUrl: url ?? "https://invalid.local", headers: () => ({}), log: opts.log,
    fetch: opts.fetch, sleep: opts.sleep, maxRetries: 3, timeoutMs: 30_000,
  });

  return {
    id,
    async health() {
      if (!url) return { ok: false, detail: "No Apps Script URL set", fix: `Deploy the Apps Script from the crm-webhook README as a web app and add its URL as ${CRM_SECRETS.sheets.url}` };
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(url)) {
        return { ok: false, detail: "That doesn't look like an Apps Script web app URL", fix: "Copy the URL ending in /exec from Deploy → Manage deployments" };
      }
      if (!token) return { ok: false, detail: "No shared token set", fix: `Add ${CRM_SECRETS.sheets.secret} to your .env and the same value as TOKEN in the script` };
      return { ok: true, detail: "Leads will be added to your Google Sheet" };
    },
    async upsertLead(lead: Lead) {
      if (!url || !token) throw new ProviderError(id, "auth", `set ${CRM_SECRETS.sheets.url} and ${CRM_SECRETS.sheets.secret}`);
      const clean = validateLead(id, lead);
      const res = await http.request("POST", url, { body: { ...leadEvent(clean, now()), token }, schema: responseSchema });
      if (res.ok === false) {
        const auth = /token/i.test(res.error ?? "");
        throw new ProviderError(id, auth ? "auth" : "invalid_request", `the sheet script refused the lead: ${res.error ?? "no reason given"}`);
      }
      return { id: res.id !== undefined ? String(res.id) : leadKey(clean) };
    },
  };
}

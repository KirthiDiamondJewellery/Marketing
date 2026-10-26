import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ProviderError, type Crm, type Lead } from "@attentionos/core";
import { HttpClient } from "@attentionos/provider-shared";
import {
  CRM_SECRETS, SIGNATURE_HEADER, TIMESTAMP_HEADER, leadEvent, leadKey, signBody, validateLead, type CrmCreateOptions,
} from "./shared.ts";

const responseSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional() });

/**
 * Generic signed JSON webhook (Zapier, Make, n8n, your own endpoint).
 * POST <CRM_WEBHOOK_URL> with headers:
 *   x-attentionos-timestamp: unix seconds
 *   x-attentionos-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *   idempotency-key: the lead id (same person → same key)
 * Any 2xx counts as delivered. If the response JSON has an `id`, it becomes the CRM id.
 */
export function createWebhookCrm(opts: CrmCreateOptions): Crm {
  const id = "crm-webhook";
  const url = opts.secret(CRM_SECRETS.webhook.url);
  const secret = opts.secret(CRM_SECRETS.webhook.secret);
  const now = opts.now ?? (() => new Date());
  const http = new HttpClient({
    provider: id, baseUrl: url ?? "https://invalid.local", headers: () => ({}), log: opts.log,
    fetch: opts.fetch, sleep: opts.sleep, maxRetries: 3, timeoutMs: 15_000,
  });

  return {
    id,
    async health() {
      if (!url) return { ok: false, detail: "No webhook URL set", fix: `Add ${CRM_SECRETS.webhook.url} to your .env` };
      if (!/^https:\/\//.test(url)) return { ok: false, detail: "Webhook URL must start with https://", fix: `Check ${CRM_SECRETS.webhook.url} in your .env` };
      if (!secret) return { ok: false, detail: "No signing secret set", fix: `Add ${CRM_SECRETS.webhook.secret} (any long random string) to your .env and to the receiver` };
      return { ok: true, detail: "Leads will be sent to your webhook, signed" };
    },
    async upsertLead(lead: Lead) {
      if (!url || !secret) throw new ProviderError(id, "auth", `set ${CRM_SECRETS.webhook.url} and ${CRM_SECRETS.webhook.secret}`);
      const clean = validateLead(id, lead);
      const at = now();
      const event = leadEvent(clean, at);
      const raw = JSON.stringify(event);
      const timestamp = String(Math.floor(at.getTime() / 1000));
      // Body is pre-serialised so the signature covers the exact bytes sent.
      const res = await http.request("POST", url, {
        rawBody: raw,
        headers: {
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signBody(secret, timestamp, raw),
          "idempotency-key": event.id,
        },
      });
      const parsed = responseSchema.safeParse(res);
      return { id: parsed.success && parsed.data.id !== undefined ? String(parsed.data.id) : leadKey(clean) };
    },
  };
}

/** For receivers written in TypeScript: verifies a lead webhook (5-minute tolerance by default). */
export function verifyLeadWebhook(
  headers: Record<string, string | undefined>,
  rawBody: string,
  secret: string,
  opts: { toleranceS?: number; now?: Date } = {},
): boolean {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const timestamp = lower[TIMESTAMP_HEADER];
  const signature = lower[SIGNATURE_HEADER];
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const nowS = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowS - Number(timestamp)) > (opts.toleranceS ?? 300)) return false;
  const expected = Buffer.from(signBody(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

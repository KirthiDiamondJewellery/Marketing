import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { PLATFORMS, ProviderError, type AttentionOSConfig, type Lead, type Logger } from "@attentionos/core";
import type { FetchLike } from "@attentionos/provider-shared";

export type CrmCreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  /** Injectable for tests. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

/** Secrets (workspace `.env`) each CRM adapter reads. Never logged. */
export const CRM_SECRETS = {
  webhook: { url: "CRM_WEBHOOK_URL", secret: "CRM_WEBHOOK_SECRET" },
  sheets: { url: "SHEETS_WEBHOOK_URL", secret: "SHEETS_WEBHOOK_SECRET" },
  gohighlevel: { token: "GHL_PRIVATE_TOKEN", locationId: "GHL_LOCATION_ID" },
  hubspot: { token: "HUBSPOT_ACCESS_TOKEN" },
} as const;

/** Optional CRM settings under `modules.community.settings.crm` in the workspace config. */
export const crmSettingsSchema = z.object({
  /** Tags added to every lead (GoHighLevel tags; HubSpot ignores them unless mapped). */
  tags: z.array(z.string().min(1)).default(["attentionos"]),
  hubspot: z.object({
    /** HubSpot contact property names for the AttentionOS fields. Leave empty to skip a field. */
    properties: z.object({
      keyword: z.string().default(""),
      utmContent: z.string().default(""),
      temperature: z.string().default(""),
      handle: z.string().default(""),
    }).default({ keyword: "", utmContent: "", temperature: "", handle: "" }),
    lifecycleStage: z.string().default("lead"),
  }).default({ properties: { keyword: "", utmContent: "", temperature: "", handle: "" }, lifecycleStage: "lead" }),
}).loose();
export type CrmSettings = z.output<typeof crmSettingsSchema>;

export function crmSettings(config: AttentionOSConfig): CrmSettings {
  const raw = (config.modules["community"]?.settings as Record<string, unknown> | undefined)?.["crm"];
  const parsed = crmSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : crmSettingsSchema.parse({});
}

export const leadSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  handle: z.string().max(100).optional(),
  platform: z.enum(PLATFORMS).optional(),
  keyword: z.string().max(40).optional(),
  utmContent: z.string().max(120).optional(),
  source: z.string().min(1).max(120),
  temperature: z.enum(["hot", "warm", "cold"]).optional(),
  notes: z.string().max(5000).optional(),
});

/** Validates a lead before it leaves the machine; at least one way to reach the person is required. */
export function validateLead(provider: string, lead: Lead): Lead {
  const parsed = leadSchema.safeParse(lead);
  if (!parsed.success) {
    throw new ProviderError(provider, "invalid_request", `lead is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  if (!parsed.data.email && !parsed.data.phone && !parsed.data.handle) {
    throw new ProviderError(provider, "invalid_request", "a lead needs an email, phone or social handle");
  }
  return parsed.data;
}

/** Stable id for a lead when the destination doesn't return one (email wins, then phone, then platform+handle). */
export function leadKey(lead: Lead): string {
  const basis = lead.email?.toLowerCase().trim()
    ?? (lead.phone ? `tel:${lead.phone.replace(/[^\d+]/g, "")}` : `${lead.platform ?? "social"}:${(lead.handle ?? "").toLowerCase().replace(/^@/, "")}`);
  return `lead_${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

export function splitName(name: string | undefined): { firstName?: string; lastName?: string } {
  if (!name) return {};
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) };
}

/** The JSON body sent to generic webhooks and Apps Script. Versioned so receivers can evolve. */
export function leadEvent(lead: Lead, at: Date) {
  return {
    type: "lead.upserted" as const,
    version: 1,
    id: leadKey(lead),
    at: at.toISOString(),
    lead,
  };
}

export const SIGNATURE_HEADER = "x-attentionos-signature";
export const TIMESTAMP_HEADER = "x-attentionos-timestamp";

/** `sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`, the same scheme receivers verify. */
export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

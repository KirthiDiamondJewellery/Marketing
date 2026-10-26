import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defineNativeJob, type WorkspaceContext } from "@attentionos/core";
import { captureFollowers } from "../analytics/accounts.ts";
import { refreshScanFollowers } from "../followers.ts";
import { funnelEventInput, recordFunnelEvents, type FunnelEventInput } from "../analytics/funnel.ts";

/**
 * Inbound business and audience data for Learn:
 * - `learn.webhook-site`: website funnel events posted to the worker at `POST /webhooks/site` (shared secret
 *   ATTENTIONOS_WEBHOOK_SECRET). Accepts one event or `{ events: [...] }`, with common field names.
 * - `learn.funnel-import`: the same events from CSV files in `imports/funnel/` (re-importing a file is safe).
 * - `learn.capture-followers`: daily follower counts per connected account.
 *
 * Website payloads are untrusted: they are validated field by field and only ever stored, never sent to a model.
 */

const KIND_ALIASES: Record<string, FunnelEventInput["kind"]> = {
  click: "click", visit: "click", page_view: "click", pageview: "click", link_click: "click", landing: "click",
  lead: "lead", lead_created: "lead", signup: "lead", sign_up: "lead", optin: "lead", opt_in: "lead", subscribe: "lead", form_submit: "lead",
  booking: "booking", booking_created: "booking", call_booked: "booking", booked: "booking", appointment: "booking", meeting_booked: "booking",
  sale: "sale", purchase: "sale", payment: "sale", order: "sale", order_paid: "sale", deal_won: "sale", won: "sale",
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const numOf = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Maps one loosely shaped website event to a validated funnel event (null when it can't be read). */
export function normalizeSiteEvent(raw: unknown): FunnelEventInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const utm = (o.utm && typeof o.utm === "object" ? o.utm : {}) as Record<string, unknown>;
  const kindRaw = str(o.kind ?? o.type ?? o.event ?? o.name)?.toLowerCase().replace(/[\s.-]+/g, "_");
  const kind = kindRaw ? KIND_ALIASES[kindRaw] : undefined;
  if (!kind) return null;
  const atRaw = str(o.at ?? o.timestamp ?? o.occurred_at ?? o.occurredAt ?? o.created_at ?? o.time);
  const at = atRaw ? new Date(/^\d+$/.test(atRaw) ? Number(atRaw) * (atRaw.length <= 10 ? 1000 : 1) : atRaw) : undefined;
  const cents = numOf(o.amount_cents ?? o.amountCents);
  const candidate = {
    kind,
    ...(at && !Number.isNaN(at.getTime()) ? { at: at.toISOString() } : {}),
    utmContent: str(o.utm_content ?? o.utmContent ?? utm.content),
    utmSource: str(o.utm_source ?? o.utmSource ?? utm.source)?.toLowerCase(),
    utmMedium: str(o.utm_medium ?? o.utmMedium ?? utm.medium),
    utmCampaign: str(o.utm_campaign ?? o.utmCampaign ?? utm.campaign),
    visitorId: str(o.visitor_id ?? o.visitorId ?? o.anonymous_id ?? o.anonymousId ?? o.session_id),
    email: str(o.email ?? (o.contact as Record<string, unknown> | undefined)?.email)?.toLowerCase(),
    valueUsd: cents !== undefined ? cents / 100 : numOf(o.value_usd ?? o.valueUsd ?? o.value ?? o.amount ?? o.revenue),
    id: str(o.id ?? o.event_id ?? o.eventId),
  };
  const clean = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
  const parsed = funnelEventInput.safeParse(clean);
  if (parsed.success) return parsed.data;
  // Drop only the fields that failed (a malformed email shouldn't lose the booking).
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  if (bad.has("kind")) return null;
  const retry = funnelEventInput.safeParse(Object.fromEntries(Object.entries(clean).filter(([k]) => !bad.has(k))));
  return retry.success ? retry.data : null;
}

export function siteEvents(payload: unknown): { events: FunnelEventInput[]; skipped: number } {
  const list = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as { events?: unknown }).events) ? (payload as { events: unknown[] }).events : [payload];
  const events: FunnelEventInput[] = [];
  let skipped = 0;
  for (const item of list.slice(0, 500)) {
    const e = normalizeSiteEvent(item);
    if (e) events.push(e);
    else skipped++;
  }
  return { events, skipped };
}

export const siteWebhookJob = defineNativeJob({
  kind: "native",
  id: "learn.webhook-site",
  agent: "analyst",
  description: "Records clicks, leads, booked calls and sales from your website so each one is credited to the post that brought it.",
  input: z.object({ provider: z.string().optional(), payload: z.unknown() }).passthrough(),
  async run(ctx) {
    const { events, skipped } = siteEvents(ctx.input.payload);
    const r = await recordFunnelEvents(ctx.ws, events, "webhook");
    if (r.stored) await ctx.progress(`Recorded ${r.stored} website event${r.stored === 1 ? "" : "s"}${r.matched ? `, ${r.matched} matched to a post` : ""}`);
    return { ...r, skipped };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------------------------------------------

/** Minimal RFC 4180 reader (quotes, doubled quotes, CRLF; `,` `;` or tab). */
export function readCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return body.map((cells) => Object.fromEntries(keys.map((k, j) => [k, cells[j] ?? ""])));
}

export function funnelImportDir(ws: WorkspaceContext): string {
  const dir = ws.secret("FUNNEL_CSV_DIR") ?? "imports/funnel";
  return isAbsolute(dir) ? dir : resolve(ws.paths.root, dir);
}

export async function importFunnelCsvs(ws: WorkspaceContext): Promise<{ files: number; stored: number; duplicates: number; skipped: number }> {
  const dir = funnelImportDir(ws);
  const out = { files: 0, stored: 0, duplicates: 0, skipped: 0 };
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort()) {
    out.files++;
    const rows = readCsv(readFileSync(join(dir, file), "utf8"));
    const events: FunnelEventInput[] = [];
    for (const r of rows) {
      const e = normalizeSiteEvent(r);
      if (!e) {
        out.skipped++;
        continue;
      }
      // Re-imports are idempotent: rows without an id get a stable one from their content.
      events.push({ ...e, id: e.id ?? createHash("sha1").update(JSON.stringify(r)).digest("hex").slice(0, 24) });
    }
    const res = await recordFunnelEvents(ws, events, "csv");
    out.stored += res.stored;
    out.duplicates += res.duplicates;
  }
  return out;
}

export const funnelImportJob = defineNativeJob({
  kind: "native",
  id: "learn.funnel-import",
  agent: "analyst",
  description: "Imports website clicks, leads, bookings and sales from CSV exports in imports/funnel/.",
  input: z.object({}),
  async run(ctx) {
    const r = await importFunnelCsvs(ctx.ws);
    if (r.stored) await ctx.progress(`Imported ${r.stored} website event${r.stored === 1 ? "" : "s"} from ${r.files} file${r.files === 1 ? "" : "s"}`);
    return r;
  },
});

export const captureFollowersJob = defineNativeJob({
  kind: "native",
  id: "learn.capture-followers",
  agent: "analyst",
  description: "Records each account's follower count once a day so Insights can chart growth.",
  input: z.object({ backfillDays: z.number().int().positive().max(365).optional() }),
  async run(ctx) {
    const r = await captureFollowers(ctx.ws, ctx.input.backfillDays ? { backfillDays: ctx.input.backfillDays } : {});
    if (r.days) await ctx.progress(`Recorded follower counts for ${r.accounts} account${r.accounts === 1 ? "" : "s"}`);
    // Handles no provider reports on: re-read the public account weekly (cheap, inside the scraping budget).
    const scan = await refreshScanFollowers(ctx.ws, { runId: ctx.runId });
    if (scan.recorded) await ctx.progress(`Read follower counts off ${scan.recorded} of your public account${scan.recorded === 1 ? "" : "s"}`);
    return { ...r, scan };
  },
});

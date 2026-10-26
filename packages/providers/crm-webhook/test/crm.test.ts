import { describe, expect, it } from "vitest";
import { ProviderError, parseConfig, silentLogger, type Lead } from "@attentionos/core";
import { create, leadKey, verifyLeadWebhook, GHL_API_VERSION } from "../src/index.ts";
import { fakeFetch, noSleep, type Route } from "./fake-fetch.ts";

const NOW = new Date("2026-10-14T12:00:00Z");
const lead: Lead = {
  email: "reader@examplebrand.example",
  name: "Demo Reader",
  handle: "demo_reader_1",
  platform: "instagram",
  keyword: "stitch",
  utmContent: "stitch_12",
  source: "instagram keyword DM",
  temperature: "hot",
};

function setup(crm: "lite" | "webhook" | "sheets" | "gohighlevel" | "hubspot", routes: Route[], secrets: Record<string, string>, settings: Record<string, unknown> = {}) {
  const ff = fakeFetch(routes);
  const s = noSleep();
  const provider = create({
    secret: (n) => secrets[n],
    config: parseConfig({ providers: { crm }, modules: { community: { settings } } }),
    log: silentLogger,
    fetch: ff.fetch,
    sleep: s.sleep,
    now: () => NOW,
  });
  return { provider, calls: ff.calls, sleeps: s.sleeps };
}

describe("crm selection", () => {
  it("lite means no external CRM", () => {
    expect(setup("lite", [], {}).provider).toBeUndefined();
  });
  it("picks the adapter named in config.providers.crm", () => {
    expect(setup("webhook", [], {}).provider?.id).toBe("crm-webhook");
    expect(setup("sheets", [], {}).provider?.id).toBe("crm-sheets");
    expect(setup("gohighlevel", [], {}).provider?.id).toBe("crm-gohighlevel");
    expect(setup("hubspot", [], {}).provider?.id).toBe("crm-hubspot");
  });
  it("health explains missing secrets without calling out", async () => {
    for (const kind of ["webhook", "sheets", "gohighlevel", "hubspot"] as const) {
      const { provider, calls } = setup(kind, [], {});
      const h = await provider!.health();
      expect(h.ok).toBe(false);
      expect(h.fix).toBeTruthy();
      expect(calls).toHaveLength(0);
    }
  });
});

describe("generic webhook", () => {
  const secrets = { CRM_WEBHOOK_URL: "https://hooks.examplebrand.example/leads", CRM_WEBHOOK_SECRET: "a-long-random-demo-secret" };

  it("sends a signed, versioned lead event the receiver can verify", async () => {
    const { provider, calls } = setup("webhook", [{ method: "POST", match: "/leads", respond: { body: { id: "crm-123" } } }], secrets);
    expect(await provider!.upsertLead(lead)).toEqual({ id: "crm-123" });
    const call = calls[0]!;
    expect(call.body).toEqual({ type: "lead.upserted", version: 1, id: leadKey(lead), at: NOW.toISOString(), lead });
    expect(call.headers["idempotency-key"]).toBe(leadKey(lead));
    expect(verifyLeadWebhook(call.headers, call.rawBody!, secrets.CRM_WEBHOOK_SECRET, { now: NOW })).toBe(true);
    expect(verifyLeadWebhook(call.headers, call.rawBody!.replace("hot", "cold"), secrets.CRM_WEBHOOK_SECRET, { now: NOW })).toBe(false);
    expect(verifyLeadWebhook(call.headers, call.rawBody!, secrets.CRM_WEBHOOK_SECRET, { now: new Date(NOW.getTime() + 10 * 60_000) })).toBe(false);
  });

  it("falls back to a stable lead id and refuses leads nobody can be reached at", async () => {
    const { provider } = setup("webhook", [{ method: "POST", match: "/leads", respond: { status: 204 } }], secrets);
    expect(await provider!.upsertLead({ ...lead, email: "READER@examplebrand.example" })).toEqual({ id: leadKey(lead) });
    await expect(provider!.upsertLead({ source: "x" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider!.upsertLead({ email: "not-an-email", source: "x" })).rejects.toBeInstanceOf(ProviderError);
  });

  it("retries 5xx then gives up with an upstream error", async () => {
    const { provider, sleeps } = setup("webhook", [{ method: "POST", match: "/leads", respond: { status: 503, body: {} } }], secrets);
    await expect(provider!.upsertLead(lead)).rejects.toMatchObject({ code: "upstream" });
    expect(sleeps).toHaveLength(3);
  });
});

describe("google sheets via Apps Script", () => {
  const url = "https://script.google.com/macros/s/AKfyDEMO/exec";
  const secrets = { SHEETS_WEBHOOK_URL: url, SHEETS_WEBHOOK_SECRET: "demo-sheet-token" };

  it("puts the token in the body (Apps Script can't read headers) and returns the row", async () => {
    const { provider, calls } = setup("sheets", [{ method: "POST", match: "/exec", respond: { body: { ok: true, row: 7 } } }], secrets);
    expect(await provider!.upsertLead(lead)).toEqual({ id: leadKey(lead) });
    expect(calls[0]!.body).toMatchObject({ type: "lead.upserted", token: "demo-sheet-token", lead });
    expect(await provider!.health()).toMatchObject({ ok: true });
  });

  it("maps a refused token to an auth error", async () => {
    const { provider } = setup("sheets", [{ method: "POST", match: "/exec", respond: { body: { ok: false, error: "bad token" } } }], secrets);
    await expect(provider!.upsertLead(lead)).rejects.toMatchObject({ code: "auth" });
  });

  it("flags URLs that aren't Apps Script web apps", async () => {
    const { provider } = setup("sheets", [], { ...secrets, SHEETS_WEBHOOK_URL: "https://docs.google.com/spreadsheets/d/x" });
    expect((await provider!.health()).ok).toBe(false);
  });
});

describe("gohighlevel", () => {
  const secrets = { GHL_PRIVATE_TOKEN: "pit-demo", GHL_LOCATION_ID: "loc-demo" };

  it("upserts a contact with location, version header and tags", async () => {
    const { provider, calls } = setup("gohighlevel", [{ method: "POST", match: "/contacts/upsert", respond: { body: { new: true, contact: { id: "ghl-contact-1" } } } }], secrets, { crm: { tags: ["attentionos", "guide lead"] } });
    expect(await provider!.upsertLead(lead)).toEqual({ id: "ghl-contact-1" });
    const call = calls[0]!;
    expect(call.url).toBe("https://services.leadconnectorhq.com/contacts/upsert");
    expect(call.headers.authorization).toBe("Bearer pit-demo");
    expect(call.headers.version).toBe(GHL_API_VERSION);
    expect(call.body).toEqual({
      locationId: "loc-demo", firstName: "Demo", lastName: "Reader", name: "Demo Reader", email: lead.email,
      source: "instagram keyword DM (stitch_12)", tags: ["attentionos", "guide lead", "keyword:stitch", "hot"],
    });
  });

  it("surfaces GoHighLevel's error message", async () => {
    const { provider } = setup("gohighlevel", [{ method: "POST", match: "/contacts/upsert", respond: { status: 422, body: { statusCode: 422, message: ["email must be an email"] } } }], secrets);
    await expect(provider!.upsertLead(lead)).rejects.toThrow(/email must be an email/);
  });
});

describe("hubspot", () => {
  const secrets = { HUBSPOT_ACCESS_TOKEN: "pat-demo" };

  it("batch-upserts by email with mapped custom properties", async () => {
    const { provider, calls } = setup("hubspot", [{ method: "POST", match: "/crm/v3/objects/contacts/batch/upsert", respond: { body: { status: "COMPLETE", results: [{ id: "501" }] } } }], secrets, {
      crm: { hubspot: { properties: { keyword: "aos_keyword", utmContent: "aos_utm_content" } } },
    });
    expect(await provider!.upsertLead(lead)).toEqual({ id: "501" });
    expect(calls[0]!.body).toEqual({
      inputs: [{
        idProperty: "email", id: lead.email,
        properties: { email: lead.email, firstname: "Demo", lastname: "Reader", lifecyclestage: "lead", aos_keyword: "stitch", aos_utm_content: "stitch_12" },
      }],
    });
  });

  it("creates (without retries) when the lead has no email", async () => {
    const { provider, calls } = setup("hubspot", [{ method: "POST", match: "/crm/v3/objects/contacts", respond: { status: 201, body: { id: "502" } } }], secrets);
    expect(await provider!.upsertLead({ handle: "demo_reader_1", platform: "instagram", source: "dm", phone: "+15550000000" })).toEqual({ id: "502" });
    expect(calls[0]!.body).toEqual({ properties: { phone: "+15550000000", lifecyclestage: "lead" } });
  });

  it("honors Retry-After on 429", async () => {
    const { provider, sleeps } = setup("hubspot", [{
      method: "POST", match: "/crm/v3/objects/contacts/batch/upsert",
      respond: [{ status: 429, headers: { "retry-after": "1" }, body: { message: "Too many requests", category: "RATE_LIMITS" } }, { body: { results: [{ id: "503" }] } }],
    }], secrets);
    expect(await provider!.upsertLead(lead)).toEqual({ id: "503" });
    expect(sleeps).toEqual([1000]);
  });
});

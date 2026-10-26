# @attentionos/provider-crm-webhook

Lead handoff (interface `Crm`). One package, four adapters, picked by `providers.crm` in the workspace config. `lite` (the default) means no external CRM: `create()` returns `undefined` and leads stay in the built-in `contacts` table.

| `providers.crm` | Adapter | Secrets |
|---|---|---|
| `webhook` | Signed JSON POST to any URL (Zapier, Make, n8n, your own endpoint) | `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_SECRET` |
| `sheets` | Google Sheets through an Apps Script web app | `SHEETS_WEBHOOK_URL`, `SHEETS_WEBHOOK_SECRET` |
| `gohighlevel` | LeadConnector API v2 `POST /contacts/upsert` | `GHL_PRIVATE_TOKEN` (Private Integration, `contacts.write`), `GHL_LOCATION_ID` |
| `hubspot` | CRM v3 contacts: batch upsert by email, create when there's no email | `HUBSPOT_ACCESS_TOKEN` (private app, `crm.objects.contacts.write`) |

Every adapter validates the lead first (an email, phone or handle is required), retries 429 and 5xx with backoff (honoring `Retry-After`), and maps failures to `ProviderError` codes.

## Lead event (webhook and Sheets)

```json
{
  "type": "lead.upserted",
  "version": 1,
  "id": "lead_<16 hex>",
  "at": "2026-10-14T12:00:00.000Z",
  "lead": { "email": "reader@example.com", "handle": "reader", "platform": "instagram", "keyword": "stitch", "utmContent": "stitch_12", "source": "instagram keyword DM", "temperature": "hot" }
}
```

`id` is stable per person (email, else phone, else platform + handle), so receivers can upsert on it.

### Verifying the generic webhook

Headers: `x-attentionos-timestamp` (unix seconds), `x-attentionos-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`, `idempotency-key: <lead id>`. In TypeScript use `verifyLeadWebhook(headers, rawBody, secret)` (5-minute tolerance). Answer any 2xx; a JSON `{ "id": "..." }` becomes the CRM id.

## Google Sheets (Apps Script)

Apps Script can't read request headers, so the shared token travels in the body.

1. Create a Sheet with a tab named `Leads` and the header row: `id, at, email, name, phone, handle, platform, keyword, utm_content, temperature, source, notes`.
2. Extensions → Apps Script, paste:

```javascript
const TOKEN = "same value as SHEETS_WEBHOOK_SECRET";
const COLUMNS = ["id", "at", "email", "name", "phone", "handle", "platform", "keyword", "utmContent", "temperature", "source", "notes"];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return json({ ok: false, error: "bad token" });
  const sheet = SpreadsheetApp.getActive().getSheetByName("Leads");
  const lead = Object.assign({ id: body.id, at: body.at }, body.lead);
  const row = COLUMNS.map((c) => lead[c] ?? "");
  const ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().map((r) => r[0]);
  const found = ids.indexOf(body.id);
  if (found >= 0) sheet.getRange(found + 2, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  return json({ ok: true, id: body.id, row: found >= 0 ? found + 2 : sheet.getLastRow() });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
```

3. Deploy → New deployment → Web app, execute as **you**, access **Anyone**. Copy the URL ending in `/exec` into `SHEETS_WEBHOOK_URL`.

## HubSpot custom fields

Standard properties (`email`, `firstname`, `lastname`, `phone`, `lifecyclestage`) are always written. To keep the keyword, `utm_content`, temperature or handle, create contact properties in HubSpot and map them:

```ts
modules: { community: { settings: { crm: { hubspot: { properties: { keyword: "aos_keyword", utmContent: "aos_utm_content" } } } } } }
```

GoHighLevel gets tags instead: the configured `crm.tags` plus `keyword:<word>` and the temperature.

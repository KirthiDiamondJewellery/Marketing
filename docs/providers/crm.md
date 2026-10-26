# CRM

When someone comments your keyword, gets your guide and leaves their details, that lead should land where you already work. AttentionOS hands leads off through the CRM interface.

| | |
|---|---|
| Interface | CRM |
| Config | `providers.crm` |
| Keys | Depends on the option (see below) |
| Setup level | [Level 3](../setup/level-3.md) |

## Options

| Option | Config value | Status | Good for |
|---|---|---|---|
| Built-in contacts | `lite` (default) | Available | No CRM yet. Leads are stored in your AttentionOS database with their keyword, post and temperature |
| Generic webhook | `webhook` | Available | Zapier, Make, n8n or any tool that accepts a webhook |
| Google Sheets | `sheets` | Available | A simple spreadsheet of leads (via a Google Apps Script web app) |
| GoHighLevel | `gohighlevel` | Available | Agencies and coaches already on it |
| HubSpot | `hubspot` | Available | Teams with a sales process in HubSpot |

Keys per option, in your workspace `.env`:

| Option | Keys |
|---|---|
| `webhook` | `CRM_WEBHOOK_URL`, optional `CRM_WEBHOOK_SECRET` (signs each payload) |
| `sheets` | `SHEETS_WEBHOOK_URL` (your Apps Script web app URL), optional `SHEETS_WEBHOOK_SECRET` |
| `gohighlevel` | `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID` |
| `hubspot` | `HUBSPOT_ACCESS_TOKEN` (private app token with contacts write scope) |

Using another CRM? Pick **webhook** and connect it through Zapier, Make or n8n.

## What a lead contains

Every lead carries what's known, never more: name and email (if given), handle and platform, the **keyword** they used, the **`utm_content`** of the post that brought them, where they came from, a **temperature** (hot, warm or cold) from DM triage, and notes.

## Set up the webhook (about 5 minutes)

1. Create a webhook trigger in your automation tool and copy its address.
2. Add it to `.env`:

   ```bash
   CRM_WEBHOOK_URL=https://hooks.example.com/your-webhook
   ```

3. Set `crm: "webhook"` under `providers` in your config.
4. Run `./aos doctor`. It sends a clearly marked test lead (no real person's data) so you can map the fields in your tool.

Each lead is sent once, with a stable id, so retries never create duplicates.

## Privacy

- Leads are personal data. They stay in your database and your CRM, never in your Brand Kit files or in git.
- DM text is untrusted: it's classified by a tool-less model call, and only the validated result is passed on.
- Delete a contact in AttentionOS and it's removed from the built-in list; remove it from your CRM separately.

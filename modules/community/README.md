# Community (Community agent)

Turns attention into conversations and conversations into leads, without sending anything the owner didn't approve. Default module, setup level 3.

## What it does

- **Keyword → DM → lead magnet.** `ensureKeyword` uses the piece's keyword or reserves one through `@attentionos/guardrails`' `checkKeyword` (4–9 letters, never reused, no substring collisions, not in the script), serialised with scripting's reservations. `community_register_lead_magnet` registers the one guide per keyword (house format checked, tracked link `utm_content=<keyword>_<post#>`, email gate). `community_create_keyword_automation` creates a **post-scoped** comment-to-DM automation through the Inbox provider (case variants added by the adapter), after the automated-DM acknowledgement and the approval the autonomy level asks for. If the post isn't live yet, `community.activate-automations` turns it on later.
- **DM triage.** No-AI prefilter (spam and threats, automation echoes, keyword-only messages, templates repeated across threads, answered threads, messages needing no reply) → batched classification by a **tool-less** model (`community.dm-classify`, output validated, persisted through `onOutput`) with verdicts cached per conversation and last message → Hot/Warm/Cold that only cool with time → **draft replies only**.
- **Comment reply drafts** from a rotating reply bank (API only, never browser automation; never the same reply twice in a row on a post).
- **Sending is approval-checked.** `community_send_reply` asks for approval of the exact text (review_all), only for hot or sensitive conversations (review_key), or sends on autopilot once the automated-DM notice is acknowledged.
- **Lead handoff.** Every lead lands in the built-in `contacts` table, then in the configured CRM (`webhook`, `sheets`, `gohighlevel`, `hubspot`). CRM failures never lose the lead.

## Jobs

| Job | Default schedule | What it does |
|---|---|---|
| `community.activate-automations` | every 15 min | Turns on approved automations once their post is live |
| `community.dm-triage` | every 2 h, 08:00–20:00 | Reads DMs, prefilters, queues batches for sorting, ages temperatures |
| `community.dm-classify` | queued by triage | Tool-less sorting and draft replies |
| `community.comment-replies` | every 3 h | Drafts comment replies from the reply bank |
| `community.send-approved` | every 10 min | Sends replies the owner approved |
| `community.inbox-event` | webhook | Files a new DM or comment into triage |
| `community.lead-captured` | webhook | Saves a lead an automation captured (e.g. Blotato's email webhook) |

## MCP tools

`community_create_keyword_automation`, `community_list_automations`, `community_register_lead_magnet`, `community_triage_inbox`, `community_list_triage_items`, `community_save_triage_verdicts`, `community_send_reply`, `community_list_leads`, `community_add_lead`, `community_add_reply_to_bank`.

## Settings (`modules.community.settings`)

| Key | Default | Meaning |
|---|---|---|
| `dm.text` | "Here's {title}. Tap the button below to open it." | Automation DM (≤ 640, no links) |
| `dm.buttonLabel` | "Get the guide" | ≤ 20 characters |
| `dm.requireFollow` | false | Instagram follow gate (see the keyword-dm-chain skill before enabling) |
| `dm.matchMode` | `exact_word` | Whole-word keyword matching |
| `triage.hotDays` / `warmDays` | 30 / 90 | Aging thresholds |
| `triage.batchSize` | 20 | Items per classifier call |
| `triage.spamPatterns`, `automationLinkPatterns`, `humanTypedLines` | | Extra prefilter rules |
| `replyBank` | [] | Seed replies (stored in `reply_bank`) |
| `leadMagnets.emailGate` | true | Default email gate |
| `crm` | | CRM adapter options (tags, HubSpot property mapping) |

Requires `acknowledgements.automatedDmRisk` before any automated DM.

## Database

`migrations/20261012091000_community_chain.sql`: `lead_magnets.slug`, `email_gate`, `status` and one guide per keyword; the `reply_bank` table; lookup indexes for triage, contacts and automations.

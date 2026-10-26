# Community

The Community agent turns attention into conversations and conversations into leads, and drafts every reply for you to approve.

| | |
|---|---|
| Agent | Community (`Cm`) |
| Tier | Default (on after setup) |
| Setup level | [Level 3](../setup/level-3.md) |
| Needs | An inbox provider (Zernio by default, Blotato for Instagram and Facebook); optionally a CRM |
| Brand Kit files | `brand/voice.md`, `brand/offers.md`, `brand/icp.md` |

## What it does

### Keyword → DM → lead magnet

- Every piece gets a keyword from the **keyword ledger**. The rules are enforced in code: 4–9 letters, never reused, no overlap with another keyword (one can't contain the other), and never a word that appears in the script.
- When the post goes live, a **comment-to-DM automation scoped to that post** is created through your provider, with case variants of the keyword.
- The DM links to a **lead-magnet guide** with a tracked link and, if you like, an email form.

### Lead magnets

A short guide in your house format for each keyword, hosted as a page on your site, a Google Doc or a Notion page, and registered so the brief and reports can link to it.

### DM triage

1. A **no-AI prefilter** sorts out spam and simple cases.
2. The rest are **classified in batches**, and verdicts are cached so the same message is never paid for twice.
3. Conversations are tagged **Hot**, **Warm** or **Cold**, and cool off over time.
4. Replies are **drafts only**. Nothing is sent without your approval.

DMs and comments are untrusted text, so they only go to model calls with no tools, and the output is validated.

### Comment replies

Drafts from a rotating reply bank, through the provider's API only. No browser automation.

### Lead handoff

New leads go to your built-in contacts list, or to your CRM through a webhook, Google Sheets, GoHighLevel or HubSpot. See [CRM](../providers/crm.md).

## What you'll see

- `/attention:inbox` in Claude Code for triage and drafts.
- Hot leads flagged in the morning brief.
- Draft replies in the approvals queue.

## Approvals

Every DM and comment reply waits for approval unless you raise the Community agent's autonomy. Even at `review_key`, sensitive replies wait.

## Settings

`providers.inbox` and `providers.crm` choose services. `modules.community.settings` holds things like guide hosting and triage aging. Turning on automated DMs needs the one-time notice `acknowledgements.automatedDmRisk`.

## Limits

- Instagram DMs need a professional (business or creator) account.
- Only one tool can own an Instagram account's DMs. If you use another comment-to-DM app, turn one off.

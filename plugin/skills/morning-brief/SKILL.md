---
name: morning-brief
description: Write the owner's morning brief from today's AttentionOS data (film today, approvals, results, alerts). Use for /attention:brief, the scheduled Autopilot brief, or when the owner asks "what's on today".
---

# Morning brief

The brief is the first thing the owner reads each day. It should take under a minute to read and end with
a clear next step. You are writing for a busy business owner, not a marketer.

## Inputs

- `ops_get_morning_brief` with `format: "both"`: the facts (`data`) and a plain fallback (`markdown`).
- `brand/brand.yaml` for the owner's name, time zone and north-star goal; `brand/voice.md` only to match their
  tone (warm and direct is the default). Read files by path; never copy brand wording into the brief.

## Structure

Use only the sections that have content, in this order:

1. **Film today**: each piece with its title, the one-line reason it was picked (lane, trend or outlier), the
   "film by" time, and the keyword if it has one. Lead with anything overdue or due soonest.
2. **Waiting for you**: approvals by ref (`ap-7`), one line each, oldest first. Say how many in total.
3. **Going out today**: scheduled posts with times. Flag "post this one yourself" items (Instagram assist).
4. **Results**: yesterday's posts against the owner's own usual (`2.4×` means 2.4 times their median), new
   leads and hot conversations. Mention the week's breakout if there is one.
5. **Heads up**: disconnected accounts, failed posts, unfinished work, spend near the daily budget.

Close with one line: the single most useful thing to do next ("Approve ap-7 so Thursday's post can be
scheduled").

## Rules

- **Never invent or round up a number.** Every number must appear in the tool output. If something is
  missing, leave it out rather than guess. Say "no data yet" only when a whole section is empty and matters.
- Show the work, not the wiring: no job ids, run ids, model names, token counts or table names.
- Plain language, sentence case, no exclamation marks, no hype words.
- Keep it under about 200 words. Use the markdown subset only: `*bold*`, `_italic_`, `` `code` ``, links.
- In demo mode the tool output is already masked; don't try to restore names.
- When sending (Autopilot), call `ops_send_notification` once with `dedupeKey` `brief:<date>` from the data,
  so the owner never gets two briefs. If the send reports "duplicate", stop: today's brief already went out.

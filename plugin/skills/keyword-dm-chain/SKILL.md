---
name: keyword-dm-chain
description: Set up the keyword → DM → lead magnet chain for a piece of content. Reserve a keyword from the ledger, register the one guide for it with a tracked link and email gate, and create a post-scoped comment-to-DM automation (after approval). Use when the user asks to "add a keyword", "send the guide by DM", "set up the comment automation" or wants leads from a reel.
---

# Keyword → DM → lead magnet

Viewer comments a word → gets a DM with a button → opens the guide on the owner's site → leaves an email → becomes a lead with the post that brought them (`utm_content`). Every link in that chain is checked in code; your job is to set it up in order and explain what's waiting on whom.

## Before anything: the risk notice

Automated DMs act on the owner's account. If `community_create_keyword_automation` answers `needs_acknowledgement`, show the notice in plain words and stop. Only the owner sets `acknowledgements.automatedDmRisk: true` in their config.

## 1. Keyword

Most pieces already have a keyword from scripting. If not, pick one with the owner:
- one plain word, 4–9 letters, tied to the guide (easy to type on a phone);
- never used before, no overlap with any used keyword (`guide` vs `guides`), not a common comment word;
- not said anywhere in the script except the CTA ("Comment STITCH").

The tools check all of this and return suggestions when a word fails. Don't argue with the ledger: keywords are never reused because old posts keep triggering their automations forever.

## 2. The guide (one per keyword)

`community_register_lead_magnet` with the piece, a title and where the guide lives (a page on the owner's site by default, or a Google Doc or Notion link). If you wrote the guide, pass `bodyMd` in the house format (see the `lead-magnet-guide` skill); the format is checked. The result's `trackedUrl` is what the DM button opens.

Keep the email gate on unless the owner says otherwise: without it, readers don't become leads.

## 3. The automation

`community_create_keyword_automation` with the piece. Defaults come from the community settings:
- **Scoped to one post.** Account-wide triggers are refused: keyword matching can fire on longer words that contain the keyword.
- **Case variants** (`stitch`, `Stitch`, `STITCH`) are added by the provider adapter, because some providers match case-sensitively.
- **The link lives in the button**, never in the DM text (the tool refuses links in the text).
- **Follow gate is off by default.** Instagram now refuses buttons to people who don't follow the account, and a second DM tool on the same account (for example another auto-DM app) makes the gate's follow-up message fail. Turn it on only if the owner asks and has tested it on their account.

What you'll hear back:
- `awaiting_approval (ap-N)`: the owner approves the DM wording and button once.
- `waiting_for_post`: approved, and it turns on by itself once the post is live (`community.activate-automations`). With Blotato, posts the owner uploaded by hand only become targetable after their first comment syncs; ask the owner to leave a comment from another account if it stays waiting.
- `failed` with "another DM tool": the account's messages are routed to another app. The fix is in Meta's settings (make the publisher the default app for messages) or turning off the follow gate.

## 4. Check the loop

Ask the owner to comment the keyword from a second account and confirm the DM, the button and the guide's email gate. `community_list_automations` shows status and errors; `community_list_leads` shows who came through, with keyword and `utm_content`.

## On other platforms

TikTok and YouTube have no comment automation: their captions say "DM me WORD" or "link in bio" (the payload check enforces it). Facebook can use the same chain without a follow gate.

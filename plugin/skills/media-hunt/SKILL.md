---
name: media-hunt
description: Find license-clean B-roll, screenshots and stills for an edit, with a provenance log and hard budgets (at most 8 stills and 6 loops per video). Use when a format calls for visuals (split-demo, news-greenscreen, popup-presenter) and the content has no attached media, or when the owner asks for B-roll.
---

# Media hunt: license-clean visuals with a paper trail

Visuals make a claim believable; the wrong visual makes the whole brand look careless or gets the post taken down.
Every asset you add must have a known source and a license that allows this use.

## Budget (hard limits)

- At most **8 stills** and **6 loops** per video. Fewer is fine. The format's `broll` block may set lower limits.
- Prefer, in order: the owner's own screen recordings and photos → official pages and docs they cite → CC0 or
  public-domain media → nothing. An empty slot is better than a doubtful asset.

## Allowed sources

| Source | License to record | Notes |
|---|---|---|
| The owner's own footage, recordings, photos | `own footage` | Best option. Ask for it in the daily brief. |
| A screenshot of a page the script cites (article, docs, pricing page, official post) | `fair use: cited source` | Capture it yourself, crop to the relevant part, keep the address visible or add a source chip. Commentary only. |
| CC0 / public domain libraries | `CC0` or `public domain` | Record the page URL of the item, not a search page. |
| CC-BY | `CC-BY-4.0 (credit: …)` | Only when the credit can go in the caption; note the exact credit text. |

Never use: stock footage you can't license, clips from other creators' videos, music or SFX packs, logos you have
no right to show (product names as plain text are fine), anything with a private person's face, name, email, phone,
address, client or deal details. When in doubt, leave it out.

## Screenshots: privacy pass

Read every screenshot at full size before it goes in. Blur or crop names, emails, phone numbers, folder and workspace
names, client or deal details, browser tabs and notifications. Keep only what proves the point.

## Provenance log (required)

Register each asset in the media library (kind `broll`, `screenshot`, `image` or `music`) with:

```json
{ "source": "official docs page", "url": "https://…", "author": "publisher name if shown", "retrievedAt": "2026-10-14", "note": "pricing table, cropped" }
```

and its license string. The plan's `broll[]` entries repeat `provenance` and `license`; the preflight gate rejects
B-roll without a license, and the provenance travels with the post.

## Placing visuals

- Line each visual up with the sentence that mentions it (output-time transcript from `editing_get_plan`).
- Change visuals at the format's rhythm (`visualChangeEveryS`); hold a still 2 to 4 s, a loop no longer than it runs.
- A visual that states a number needs the same `evidenceId` as the claim it supports.

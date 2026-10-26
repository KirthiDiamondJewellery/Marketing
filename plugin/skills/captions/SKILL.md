---
name: captions
description: Turn one script or transcript into strict per-platform caption JSON for Instagram, TikTok, YouTube, Facebook, LinkedIn and X, following each platform's CTA, length and hashtag rules. Use when a script needs captions or a filmed video needs its final captions (scripting.captions job).
---

# Captions

One transcript becomes one strict JSON object with a key per platform. The validator checks it in code; anything off-shape or off-rule is rejected with the exact fix.

## Read first

`scripting_get_content_brief` gives the CTA type, the keyword and the platforms. Read `brand/voice.md` (tone and banned words) and `brand/brand.yaml` (`hashtagPool`).

## Shape (no extra keys)

```json
{
  "instagram": {"caption": "...", "hashtags": ["#...", "#...", "#..."]},
  "tiktok":    {"caption": "...", "hashtags": ["#...", "#...", "#..."]},
  "youtube":   {"title": "...", "description": "...", "hashtags": ["#...", "#...", "#..."]},
  "facebook":  {"caption": "...", "hashtags": ["#...", "#...", "#..."]},
  "linkedin":  {"text": "...", "hashtags": ["#...", "#...", "#..."]},
  "x":         {"text": "...", "hashtags": []}
}
```

Hashtags go in the `hashtags` list, never inside the text; they're appended when the post is published.

## Platform rules

- **Instagram**: contains the keyword when the CTA is a comment or DM keyword ("Comment WORD and I'll send you ..."). Links don't click in captions; say "link in bio".
- **TikTok and YouTube**: comment keywords don't trigger DMs there. Use "DM me WORD" or "link in bio".
- **YouTube**: title under 100 characters, the claim in plain words; description carries the CTA.
- **Facebook, LinkedIn, X**: never ask people to comment the keyword; use a link line instead.
- **LinkedIn**: the first line carries the hook; put links in the first comment, not the body.
- **X**: the whole post including hashtags fits in 280 characters (each link counts as 23). Zero to three tags.
- **Hashtags**: 3 to 5 niche tags per platform (X fewer), lowercase, letters, numbers and underscores only. Tags that say who it's for and what it's about. Never broad reach tags (#fyp, #viral, #explore and the like). Prefer tags from `hashtagPool`.

## Copy

Same voice as the script, written for reading: first line is the hook in plain words, then one or two lines of value, then the CTA. No banned phrases, no long dashes, no claims that aren't in the script's claim ledger.

Save with `scripting_save_captions`. If it reports problems, fix exactly those and save again.

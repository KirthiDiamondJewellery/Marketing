# Notices you accept before turning on certain features

A few AttentionOS features touch other companies' platforms or licenses in ways you should decide on yourself. Each one stays off until you've read its notice and set the matching acknowledgement in `config/attentionos.config.ts`:

```ts
acknowledgements: {
  scrapingTerms: true,
  automatedDmRisk: true,
  // trialReelsRisk: true,
  // remotionLicense: true,
},
```

Everything else keeps working while a feature waits for your acknowledgement. `./aos cli status` and `./aos doctor` tell you which features are waiting.

## Reading public posts through a third-party service (`scrapingTerms`)

**Used by:** competitor scans through Apify or yt-dlp (Research).

Collecting public posts through a third-party scraping service may conflict with a platform's terms of use, and platforms can change what they allow at any time. AttentionOS only reads the accounts you list in `brand/competitors.yaml`, never logs in as you, never automates a browser, and checks your scraping budget before every run.

**Alternative:** the official Instagram Graph API (`scraper: "iggraph"`) reads public business and creator accounts without this notice.

## Automated replies in DMs (`automatedDmRisk`)

**Used by:** comment-keyword → DM automations and inbox tools (Community).

Sending automated direct messages is governed by each platform's messaging rules, and Instagram limits what you can send to people who haven't messaged you first (for example, link buttons to non-followers). AttentionOS creates keyword automations through your publishing provider's official API, drafts every other reply for your approval, and never sends a free-form DM without it. Running two DM automation tools on the same account can make both fail; use one.

## Trial reels (`trialReelsRisk`)

**Used by:** scheduling trial reels ([trial-reels](modules/trial-reels.md)). Making and previewing them doesn't need it.

Trial reels are shown to non-followers first. Posting many near-identical variations can look like spam to a platform and may reduce reach or trigger restrictions. AttentionOS caps trial reels per day, requires a one-time proof run, and never posts variations without your approval.

## Remotion company license (`remotionLicense`)

**Used by:** the optional motion engine (Editing, planned for v0.4).

Remotion is free for individuals and companies of up to three people. Larger companies need a paid Remotion company license. AttentionOS's default cut engine has no such requirement.

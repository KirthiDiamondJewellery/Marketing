# Apify

[Apify](https://apify.com) runs ready-made scrapers ("actors") in the cloud. AttentionOS uses it by default to read public competitor posts on Instagram and TikTok, and optionally posts on X for the trend radar.

| | |
|---|---|
| Interface | Scraper (and the X trend source) |
| Config | `providers.scraper: "apify"` (default) |
| Key | `APIFY_TOKEN` |
| Cost | Free plan includes monthly credit; paid plans from about $29/month |
| Setup level | [Level 1](../setup/level-1.md) |

## Set up (about 5 minutes)

1. Create an account at [apify.com](https://apify.com).
2. Open **Settings → API & Integrations** and copy your **personal API token**.
3. Add it to your workspace `.env`:

   ```bash
   APIFY_TOKEN=apify_api_replace-me
   ```

4. Run `./aos doctor`. It confirms the token works and shows your remaining monthly credit, without spending any.

## How AttentionOS keeps cost down

- **Budget guard.** Before every scan, AttentionOS estimates the cost and checks it against `budgets.scrapingMonthlyUsd` (default $29). If the scan would go over, you get an alert instead of a bill.
- **Daily rotation.** Only a slice of your tracked creators is scanned each day, so cost stays flat whether you track 5 creators or 50.
- **Small pulls.** Only recent posts are fetched for each creator; older history is kept in your database.

You can see what you've spent in the weekly cost watch.

## Platform terms

Reading public posts through a third-party service may conflict with a platform's terms of use. Before the first scan, AttentionOS shows a notice and asks you to acknowledge it (`acknowledgements.scrapingTerms`). AttentionOS never logs in as you, never automates a browser, and only reads public posts from accounts you list in `brand/competitors.yaml`.

## Troubleshooting

**"Budget reached"** · Your monthly scraping cap is protecting you. Raise `budgets.scrapingMonthlyUsd` or wait for the new month.

**A creator returns no posts** · Check the handle in `brand/competitors.yaml` (no `@`, exact spelling) and that the account is public.

**"Bad key"** · Recopy the token; tokens can be regenerated in Apify, which invalidates the old one.

## Alternatives

- [Instagram Graph API](iggraph.md): free, Instagram business and creator accounts only.
- [yt-dlp](ytdlp.md): free, for TikTok and YouTube downloads.

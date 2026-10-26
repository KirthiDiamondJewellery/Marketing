# Instagram Graph API

Meta's official API for Instagram professional accounts. AttentionOS can use it for two things:

- **Your own analytics**, including a full-history backfill of your posts.
- **Competitor research** through business discovery, which reads public business and creator accounts.

| | |
|---|---|
| Interfaces | Own analytics, Scraper |
| Config | `providers.ownAnalytics: "iggraph"` and/or `providers.scraper: "iggraph"` |
| Keys | `IG_ACCESS_TOKEN`, `IG_USER_ID` |
| Cost | Free |
| Setup level | [Level 1](../setup/level-1.md) |

## Before you start

- Your Instagram account must be a **business or creator** account.
- It must be **linked to a Facebook Page** you manage.
- You need a Meta developer account (free) at [developers.facebook.com](https://developers.facebook.com).

## Set up (about 15 minutes)

1. In the Meta developer dashboard, **create an app** and add the **Instagram** product.
2. Grant the permissions `instagram_basic`, `instagram_manage_insights` and `pages_show_list` (and `pages_read_engagement` if asked).
3. Generate a **user access token**, then exchange it for a **long-lived token** (valid about 60 days). The developer tools page has a button for this.
4. Find your **Instagram user id** (a long number) with the Graph API Explorer: query `me/accounts`, pick your Page, then read its `instagram_business_account` id.
5. Add both to `.env`:

   ```bash
   IG_ACCESS_TOKEN=replace-me
   IG_USER_ID=replace-me
   ```

6. Run `./aos doctor`. It checks the token and tells you how many days it has left.

## Limits

- Business discovery only reads **business and creator** accounts. Personal accounts can't be read.
- It returns likes, comments and captions, but **not views** for other accounts' reels, so outlier scores lean on comments.
- Tokens expire. Doctor warns you a week before; repeat step 3 to renew.
- Meta applies hourly rate limits. AttentionOS spaces requests to stay well under them.

## Platform terms

This is Meta's official API, used within its documented limits. AttentionOS still shows the scraping notice once, because competitor research reads accounts other than yours.

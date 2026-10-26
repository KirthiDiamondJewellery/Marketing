# Zernio

Zernio is the default publisher, inbox and analytics provider. One API key covers scheduling, comment-to-DM automations, DMs and comments, per-post metrics and webhooks. The first two connected accounts are free.

| | |
|---|---|
| Interfaces | Publisher, Inbox, Own analytics, webhooks |
| Config | `providers.publisher: "zernio"`, `providers.inbox: "zernio"`, `providers.ownAnalytics: "zernio"` (the defaults) |
| Keys | `ZERNIO_API_KEY` (required), `ZERNIO_WEBHOOK_SECRET` (for webhooks), `ZERNIO_PROFILE_ID` (optional, one brand per workspace) |
| Package | `@attentionos/provider-publish-zernio` |
| Setup level | [Level 3](../setup/level-3.md) (webhooks: [Level 4](../setup/level-4.md)) |
| Docs checked | 2026-10-10 against [docs.zernio.com](https://docs.zernio.com) and the OpenAPI spec at `https://zernio.com/openapi.json` |

## Pricing

Per connected account per month, graduated, every feature included ([pricing](https://docs.zernio.com/pricing)):

| Accounts | Price each |
|---|---|
| 1–2 | Free, no card (X needs a card) |
| 3–10 | $6 |
| 11–100 | $3 |
| 101+ | $1 |

A typical owner with 5 accounts pays $18 a month. Profiles are free. Outbound DMs, including automation DMs, are metered from 2026-10-01: the first 10,000 a month are free, then $1 per 10,000; without a card the send past 10,000 fails (AttentionOS reports it as "the free DM allowance is used up"). Posting to X is billed per call by X.

## Set up (about 20 minutes)

1. **Create an account** at zernio.com. No card is needed for the first two accounts.
2. **Connect your social accounts** in the Zernio dashboard. For Instagram, use the Facebook Login option if you want collaborators, paid-partnership labels or audio settings; Instagram Login is enough for posting, comments and DMs.
3. **Create an API key** (dashboard → API keys). It starts with `sk_` and is shown once. Add it to your workspace `.env`:
   ```bash
   ZERNIO_API_KEY=sk_...
   ```
4. **One brand per workspace?** Zernio groups accounts into **profiles**. For an agency with several brands, create one profile per brand and either:
   - add `ZERNIO_PROFILE_ID=<profile id>` to each brand's `.env` (AttentionOS then only sees that profile's accounts), or
   - create a **profile-scoped key** for each brand (`scope: profiles`) so a workspace can't touch another brand at all. Restricted keys can also switch off whole areas (ads, billing, telephony).
5. Run `attentionos doctor`. It lists your connected accounts and tells you which ones need reconnecting.

### Webhooks (Autopilot, Level 4)

Webhooks make posts flip to "live" within seconds and feed new DMs and comments to triage. Without them, AttentionOS polls (`publishing.publish-due` every 10 minutes, `community.dm-triage` every two hours, `research.own-sync` every six hours).

1. Start the worker and expose it with a tunnel (for example Cloudflare Tunnel or ngrok). The endpoint is `POST https://<your-tunnel>/webhooks/zernio`.
2. Pick a long random secret and add it to `.env` as `ZERNIO_WEBHOOK_SECRET`. **Zernio never generates one: you choose it.**
3. In the Zernio dashboard (Webhooks), add the URL and the same secret, and subscribe to: `post.*`, `message.received`, `comment.received`, `conversation.started`, `account.connected`, `account.disconnected`, `analytics.synced`. You can also register it through the API: `POST /v1/webhooks/settings` with `{ name, url, events, secret }`.
4. Send a test from the dashboard (`webhook.test`); the worker log shows it was verified.

How the worker uses them:

| Event | What happens |
|---|---|
| `post.scheduled`, `post.published`, `post.platform.*`, `post.failed`, `post.partial`, `post.cancelled`, `post.tiktok.url_resolved` | `publishing.post-event` updates the post (and its piece) |
| `post.external.*`, `analytics.synced` | one `research.own-sync` per hour |
| `message.received`, `comment.received`, `conversation.started` | `community.inbox-event` files it into triage (rules only) |
| `account.connected`, `account.disconnected` | `publishing.sync-accounts` |
| anything else | acknowledged and ignored |

Every event is deduplicated on its event id, so Zernio's retries never run twice.

## How the adapter maps to the API

| AttentionOS | Zernio |
|---|---|
| Auth | `Authorization: Bearer sk_...`, base URL `https://zernio.com/api/v1` |
| `listAccounts` | `GET /accounts` (`?profileId=` when set). `needsReconnection` → expired, inactive or disabled → error. `twitter` is X |
| `uploadMedia` | `POST /media/presign` `{ filename, contentType, size }` → `PUT` the bytes to `uploadUrl` (no auth header) → `publicUrl`. Max 5 GB; `application/octet-stream` is refused. Public `https://` URLs are passed through |
| `publish` | `POST /posts` with `content`, `mediaItems[{type,url}]`, `platforms[{platform, accountId, platformSpecificData}]`, `scheduledFor` (UTC, with Z) or `publishNow: true`, and `metadata.attentionosKey` (echoed in webhooks) |
| Idempotency | `Idempotency-Key` header: a UUID derived from `post:<content>:<platform>:<version>` (24-hour window). Zernio's own content-hash dedupe answers 409 with `existingPostId`; the adapter returns that post instead of failing |
| Instagram | `shareToFeed` (default true), `collaborators` (no @, max 3), `trialParams.graduationStrategy: "MANUAL"` for trial reels (never shared to feed), `instagramThumbnail`, `firstComment` |
| TikTok | root `tiktokSettings`: `privacy_level`, `allow_comment`, `allow_duet`, `allow_stitch`, `video_made_with_ai`, plus `content_preview_confirmed` and `express_consent_given` (set because a person approved the post) |
| YouTube | `title` (under 100 characters), `visibility`, `madeForKids` |
| Facebook | `contentType: "reel"` for video, `pageId` |
| `getPost` / `cancel` | `GET /posts/{id}`, `DELETE /posts/{id}` (any status except published; it never deletes a live post) |
| `createDmAutomation` | `POST /comment-automations` with `profileId`, `accountId`, `trigger: "comment"`, `platformPostId` (or `postId` for a Zernio post, which works **before** it's live), `keywords` (lower, Title and UPPER variants), `matchMode` (`word` for exact words), `dmMessage`, URL `buttons`, optional `commentReply` with `publicReplyPolicy: "after_dm"`, `repeatPolicy: { mode: "once" }`, and for a follow gate `audience: { followerStatus: "follower", whenUnknown: "verify" }` + `followGate` |
| `listConversations` / `listMessages` / `sendMessage` | `GET /inbox/conversations`, `GET /inbox/conversations/{id}/messages?accountId=`, `POST /inbox/conversations/{id}/messages` with an idempotency key. Conversation ids are `<accountId>:<conversationId>` because Zernio needs both |
| `listComments` / `replyToComment` | `GET /inbox/comments/{postId}?accountId=`, `POST /inbox/comments/{postId}` `{ accountId, message, commentId }` |
| `listPostMetrics` | `GET /analytics?accountId=&source=all`. Watch time arrives in ms (stored in seconds), skip rate as a percentage (stored 0–1); entries with `syncStatus: unavailable` are skipped |
| Errors | `{ error, type, code }`: `authentication_error`/`permission_error` → auth, `rate_limit_error` → rate_limited, `not_found`, `invalid_request_error`, `platform_error`/`api_error` → upstream. `not_thread_owner` → conflict (another app owns the conversation), `message_allowance_exceeded` → budget_exceeded |
| Rate limits | 60 requests/min for 0–2 accounts, 600 for 3–2,000; analytics 6–20 per second. 429s are retried with backoff, honoring `Retry-After` (or `details.retryAfterSeconds`) |
| Posting caps | 25 posts per hour per account; daily: Instagram 100, Facebook 100, Threads 250, X 50, TikTok 15 videos + 15 photos |

## Verified behaviour and known limits

Checked against Zernio's documentation on 2026-10-10. Items marked "needs live test" are known limits: the docs don't settle them, so AttentionOS ships with safe defaults that work either way (follow gate off, whole-word matching with case variants, post-scoped automations). If you rely on one of them, check it on your own account with the [checklist](#check-the-open-items-on-your-account) below.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | IG comment-to-DM with **follow gate** and **URL buttons** | **Partial, needs live test.** `followGate`, `audience.whenUnknown: "verify"` and up to 3 `url` buttons are documented. Since late August 2026 Instagram refuses buttons, cards and attachments to commenters who don't follow the account (Meta code 2, subcode 1545133), and the failed call still uses the comment's single private reply. Whether the gate message falls back to plain text isn't documented (logs expose `gateButtonStatus: rejected`). AttentionOS ships the follow gate **off by default** and puts the link in a button. | [create comment automation](https://docs.zernio.com/comment-automations/create-comment-automation), [private reply](https://docs.zernio.com/comments/send-private-reply-to-comment), [Instagram](https://docs.zernio.com/platforms/instagram) |
| 2 | Keyword matching (case and substring) | **Partial.** Substring behaviour is documented: `contains` (the default) fires inside other words ("app" fires on "happy"); `word` matches whole words; `exact` the whole comment. **Case sensitivity isn't documented.** The adapter uses `word` for exact keywords and always sends lower, Title and UPPER variants; the keyword ledger forbids substring overlaps. | [create comment automation](https://docs.zernio.com/comment-automations/create-comment-automation) |
| 3 | IG Reels publishing (`shareToFeed`, collaborators, trial reels) | **Supported.** `shareToFeed`, `collaborators` (max 3) and `trialParams.graduationStrategy` (`MANUAL` or `SS_PERFORMANCE`) are documented; responses carry `isTrialReel`. `firstComment` on Reels is ambiguous ("feed posts and carousels" vs "not applied to Stories"). | [Instagram](https://docs.zernio.com/platforms/instagram) |
| 4 | Per-platform metrics actually returned | **Supported as documented, needs live test.** Instagram: impressions, reach, likes, comments, shares, saves, views, Reels watch time and skip rate; `follows` is null on Reels. TikTok extras (saves, reach, watch time, completion, follows) only on Business-app connections, filled 24–48 h later. LinkedIn personal accounts only for posts published through Zernio. `analytics.synced` fires about hourly and carries no numbers. | [analytics](https://docs.zernio.com/analytics/get-analytics), platform pages |
| 5 | TikTok privacy and AI-label fields | **Supported.** `privacy_level` and `video_made_with_ai`; Business-app connections (all new ones) only accept public videos unless posted as drafts. | [TikTok](https://docs.zernio.com/platforms/tiktok) |
| 6 | Webhook signatures and reliability | **Supported.** `X-Zernio-Signature` = lowercase hex HMAC-SHA256 of the raw body with your secret; up to 7 attempts over about 51 hours, then a dead-letter queue with redelivery; endpoints auto-disable after 3 days of failures. **No timestamp is signed and there's no replay window**, so the worker dedupes on the event id. | [webhooks](https://docs.zernio.com/webhooks) |
| 7 | Coexistence with other DM tools on the same IG account | **Not documented, needs live test.** Only Meta thread control is documented: while another app owns a thread Zernio sees it in standby, its automations don't run and sends fail with `not_thread_owner` (mapped to a plain "another app controls this conversation"). Two tools answering the same comment isn't covered, and Instagram allows one private reply per comment. Keep one DM tool per account. | [thread control](https://docs.zernio.com/messages/set-conversation-thread-control), [DM-tool migration guide](https://docs.zernio.com/guides/manychat-patterns) |

**Fallback if a check fails live:** the Inbox can run on Blotato while Zernio publishes (`providers.inbox: "blotato"`).

### Check the open items on your account

To confirm the open items yourself, use a test Instagram account and one throwaway reel. Results are welcome as an issue or a PR to this page.

1. Create an automation with a follow gate and a URL button; comment the keyword from a **non-follower** and a **follower** account. Record what each receives.
2. Comment `stitch`, `Stitch`, `STITCH` and `stitches` with `matchMode: word`. Record which fire.
3. Publish a reel with `shareToFeed: false` + `trialParams`, and one with a collaborator. Confirm the trial reel isn't on the grid.
4. After 48 hours, compare `GET /analytics` with the app's insights for Instagram and TikTok.
5. Post to TikTok with `privacy_level: SELF_ONLY` and `video_made_with_ai: true` on a Business-app connection; record the error.
6. Point a webhook at a tunnel, verify signatures, stop the tunnel for an hour and confirm redelivery.
7. Connect a second auto-DM tool to the same account and comment the keyword; record which tool answers and what fails.

## Troubleshooting

| You see | Do this |
|---|---|
| "No Zernio API key" | Add `ZERNIO_API_KEY` to `.env` |
| "instagram @handle needs reconnecting" | Reconnect the account in the Zernio dashboard, then `./aos doctor` |
| "Another app controls this Instagram conversation" | Another DM tool owns the thread. Hand it to Zernio in Meta Business Suite or reply from that tool |
| "Zernio's free DM allowance for this month is used up" | Add a card in Zernio, or wait for next month |
| Webhooks return 401 | `ZERNIO_WEBHOOK_SECRET` doesn't match the secret saved in Zernio |
| `profile_id` filter seems ignored | Zernio ignores unknown snake_case query params; AttentionOS uses `profileId` |

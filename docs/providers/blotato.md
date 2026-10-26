# Blotato

Blotato is a supported alternative to Zernio for publishing, Instagram and Facebook comment-to-DM, and analytics of posts published through it. Use it if you already pay for Blotato, or to run DMs on Blotato while Zernio publishes.

| | |
|---|---|
| Interfaces | Publisher, Inbox (Instagram and Facebook), Own analytics (Blotato-published posts only), lead webhook |
| Config | `providers.publisher: "blotato"`, `providers.inbox: "blotato"`, `providers.ownAnalytics: "blotato"` |
| Keys | `BLOTATO_API_KEY` (required); `BLOTATO_WEBHOOK_URL` and `BLOTATO_WEBHOOK_SECRET` (optional, lead capture) |
| Package | `@attentionos/provider-publish-blotato` |
| Setup level | [Level 3](../setup/level-3.md) |
| Docs checked | 2026-10-10 against [help.blotato.com](https://help.blotato.com) and the OpenAPI spec at `https://backend.blotato.com/openapi.json` |

## Pricing

From [blotato.com/pricing.md](https://www.blotato.com/pricing.md) (effective 2026-09-10):

| Plan | Price | Accounts | Max upload | Queued posts | Active DM contacts a month |
|---|---|---|---|---|---|
| Starter | $29/mo | 20 | 400 MB | 200 | 1,000 |
| Creator | $97/mo | 40 | 1 GB | 1,000 | 6,000 |
| Agency | $499/mo | 100 | 1 GB | 3,000 | 15,000 |

**The free trial doesn't include the API.** Creating an API key during the trial ends it and starts the paid plan (Blotato shows a warning first). AI credits only matter for Blotato's own image and video generation.

## Set up (about 15 minutes)

1. Subscribe to a plan, connect your accounts in Blotato, and for Facebook pick the Pages to post to.
2. Copy the API key from Settings → API. **Keep the trailing `=` characters**: a key with them stripped gets a 401. Add it to `.env`:
   ```bash
   BLOTATO_API_KEY=...
   ```
3. In `config/attentionos.config.ts`, set `publisher`, `inbox` and/or `ownAnalytics` to `"blotato"`.
4. Run `attentionos doctor`. Each Facebook Page shows up as its own account.

### Lead capture (optional)

Blotato calls a webhook after a keyword DM is sent, but the body is only `{"email": "...", "isFollower": true}`: no handle, no comment, no automation id. AttentionOS fills the gap by asking Blotato to send three headers with every automation it creates: a shared secret, the keyword and the post.

1. Expose the worker (`POST https://<your-tunnel>/webhooks/blotato`).
2. Add `BLOTATO_WEBHOOK_URL=https://<your-tunnel>/webhooks/blotato` and `BLOTATO_WEBHOOK_SECRET=<long random string>` to `.env`.
3. Create (or re-create) your keyword automations. Leads with an email land in your contacts and CRM through `community.lead-captured`, tagged with the keyword and the post's `utm_content`.

Blotato waits 15 seconds, never retries and doesn't follow redirects, so the tunnel must answer directly.

## Known API quirks

Each is handled in code, not left to the reader.

| Quirk | What the adapter does |
|---|---|
| **`postSubmissionId` ≠ post id.** Creating a post returns a submission id that is only good for polling status. Comments, DM automations and analytics need Blotato's **published post id**, and posts you upload yourself have none until their first comment syncs. | `publish` stores the submission id. `resolvePublishedPostId` turns a submission id into the published id (matching the public URL in the published listing), accepts an existing published id, or finds a hand-uploaded post through synced comments, and otherwise says "leave a comment on the post from another account, then try again". |
| **`GET /posts/{id}` answers `in-progress` for any id it doesn't know.** | Only submission ids are polled; a scheduled post is reported as not live yet instead of being guessed at. |
| **Keyword triggers match substrings, and have matched case-sensitively in practice** (the docs now say case-insensitive). | Every automation sends lower, Title and UPPER variants; automations must be scoped to one post (account-wide is refused); the keyword ledger forbids substring overlaps. |
| **Error 30101** when a second DM tool or a second workspace is connected to the same Instagram account: the follow-gate message goes out, then the real DM fails. Not in Blotato's docs; the docs describe it as a Meta conversation-routing conflict. | Mapped to a `conflict` with the fix: make Blotato the default app for messages in Meta Business Suite, or turn the follow gate off and put the link in the first message. The follow gate is off by default. |
| **No licensed audio** (and no paid-partnership label) through the API. | Instagram main feed defaults to assist (ADR-13): you post with trending audio yourself. |
| **The DM webhook payload is minimal** (`{email, isFollower}`). | Context travels in custom headers (above); without an email nothing is handed off. |
| **Analytics only cover posts published through Blotato**, on 8 platforms (**no LinkedIn**), and counts arrive as strings. | `listPostMetrics` reads the published listing, skips LinkedIn and converts counts to numbers; plans without analytics (404) are skipped. Use Zernio or the Instagram Graph API for history. |
| **TikTok captions can't be edited after posting.** | The payload check runs before every send; the TikTok caption must say "DM me WORD" or "link in bio". |
| **Large uploads need long timeouts.** | Presigned `PUT` uploads stream the file with a 10-minute timeout and never print the upload URL. A timed-out upload is never followed by a post. |
| **`scheduledTime` and `useNextFreeSlot` must sit at the payload root.** Nested inside `post`, they're silently ignored and the post goes out immediately. | `buildPostBody` puts `scheduledTime` (UTC) at the root, next to `post`; there's a test for it. `useNextFreeSlot` isn't used (AttentionOS picks slots itself). |
| **Presigned upload.** | `POST /v2/media/uploads { filename }` → `PUT` the bytes to `presignedUrl` with the file's content type → use `publicUrl`. Public `https://` URLs skip the upload. |
| **H.264/AAC.** Blotato only auto-converts clips up to 120 seconds, and X rejects VP9 (common in reels downloaded from Instagram). | Local videos are probed with `ffprobe`; anything other than H.264 video with AAC (or no) audio is refused with the fix ("convert to H.264/AAC, MP4, yuv420p, +faststart"). |
| **429s and bursts.** `POST /posts` allows 30 a minute; 429 bodies say "retry in N seconds" instead of sending `Retry-After`. | Post creates are spaced 2.5 seconds apart. Reads retry 429s waiting as long as the message says, with backoff on 5xx. Post creates are **never retried blindly** (Blotato has no idempotency key): an ambiguous failure is reported, and the publishing module asks you to check the calendar. |
| **Cancelling needs the schedule id.** | `cancel` finds the schedule by time in `GET /v2/schedules` and deletes it with no JSON body (a JSON content type gets a 400). |
| **Facebook needs a Page; Facebook video must be a reel.** | Pages are listed as accounts `<accountId>/<pageId>`; video goes out with `mediaType: "reel"`. |
| **Trial reels.** The field is `trial`, not `trialReel`. | `target.trial = { graduationStrategy: "MANUAL" }`, and trial reels are never shared to the feed. |
| **One API key per Blotato account; no scoped keys.** | One workspace per Blotato account. Agencies with several brands are cheaper on Zernio profiles. |

## How the adapter maps to the API

| AttentionOS | Blotato (`https://backend.blotato.com/v2`, header `blotato-api-key`) |
|---|---|
| `health` | `GET /users/me` (subscription status; spends nothing) |
| `listAccounts` | `GET /users/me/accounts` (+ `/subaccounts` for Facebook Pages); `twitter` is X |
| `publish` | `POST /posts { post: { accountId, content: { text, mediaUrls, platform }, target }, scheduledTime }` |
| TikTok target | all seven required fields: `privacyLevel`, `disabledComments`, `disabledDuet`, `disabledStitch`, `isBrandedContent`, `isYourBrand`, `isAiGenerated` |
| YouTube target | `title`, `privacyStatus`, `shouldNotifySubscribers`, `isMadeForKids` |
| `getPost` | `GET /posts/{postSubmissionId}`: `in-progress`, `scheduled`, `published` (`publicUrl`), `failed` (`errorMessage`) |
| `createDmAutomation` | `POST /dm-automations` with one `comment-received` trigger (`keywords`, `postId`), `dmMessage` (≤ 640), `buttons` (≤ 3, titles ≤ 20), optional `followGate` (Instagram only), optional `webhook` |
| Comments and DMs | `GET/POST /comments`, `GET /conversations`, `GET/POST /messages` (Instagram and Facebook; 45-day retention) |
| `listPostMetrics` | `GET /posts?status=published` (+ `GET /posts/{publishedPostId}/analytics` when the listing has no numbers) |

Rate limits per minute: `POST /posts` 30, post reads 60, analytics 60, presigned uploads 120, DM automation writes 30. Blotato's own daily caps: Instagram 50 per account, TikTok 25, Facebook 25 per Page, LinkedIn 50, YouTube 10 (Starter) or 25.

## Troubleshooting

| You see | Do this |
|---|---|
| "Blotato rejected the API key" | Copy the key again including any trailing `=` |
| "Your Blotato subscription isn't active" | The API needs a paid plan |
| "Blotato doesn't know this post yet" | Leave a comment on the post from another account, wait a minute, then the automation turns on by itself |
| "Another DM tool is connected" (30101) | Make Blotato the default messaging app in Meta Business Suite, or switch the follow gate off |
| "monthly active-contacts limit is reached" | Upgrade the plan or wait for the next cycle |
| Videos refused as not H.264/AAC | Re-export as H.264 MP4 with AAC audio |

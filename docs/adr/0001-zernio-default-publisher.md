# ADR-1: Zernio is the default publisher; Blotato is a supported adapter

- **Status:** Accepted (the documentation spike is done; three DM behaviours remain known limits, see Consequences)
- **Date:** 2026-10-10
- **Deciders:** Maintainers

## Context

AttentionOS needs one service to publish to 6–7 platforms, run comment-to-DM automations, read DMs and comments, and return per-post metrics for the learning loop. Most users are business owners with 4–6 accounts who should be able to try the system for free.

Pricing and features were checked on 2026-10-10 ([Zernio pricing](https://docs.zernio.com/pricing), [Zernio docs](https://docs.zernio.com), [Blotato pricing](https://www.blotato.com/pricing.md), [Blotato docs](https://help.blotato.com)).

| | Zernio | Blotato |
|---|---|---|
| Price model | Per connected account: first 2 free, accounts 3–10 at $6, 11–100 at $3, 101+ at $1. Everything included | Plans: $29 (20 accounts), $97 (40), $499 (100) |
| Typical owner (5 accounts) | **$18/mo** | $29/mo |
| Agency (25 accounts) | ~$93/mo | $97/mo |
| Try the API for free | **Yes**, no card | No: the trial excludes the API, and creating a key starts billing |
| Platforms | 16 | 9 |
| Analytics | All accounts, including posts made elsewhere; `analytics.synced` webhook; LinkedIn included | 8 platforms, no LinkedIn; only posts published through Blotato |
| Inbox and DMs | Inbox API, comment-to-DM with word matching and follow gate, `message.*`, `comment.received`, `conversation.started` webhooks | Instagram and Facebook comment-to-DM with follow gate; DM webhook body is only `{email, isFollower}`; no account-wide webhooks |
| Multi-brand | Profiles and profile-scoped or restricted keys | One API key per account |
| Developer tooling | REST, OpenAPI, SDKs, MCP, CLI, signed webhooks, `Idempotency-Key` | REST v2, OpenAPI, MCP; no idempotency key |
| Extras | WhatsApp, ads, SMS, voice | AI image and video generation credits |
| Metered extras | Outbound DMs above 10,000 a month ($1 per 10,000); X calls | None |

## Decision

- **Zernio is the default** Publisher, Inbox and Own analytics provider.
- **Blotato is a first-class adapter** behind the same interfaces, with its known API quirks handled in code ([provider guide](../providers/blotato.md)).
- The Inbox can be set independently (`providers.inbox`), so DMs can run on Blotato while Zernio publishes if a live check finds a gap.

## Evidence from the documentation spike

Full table with links in [the Zernio guide](../providers/zernio.md#verified-behaviour-and-known-limits).

| # | Check | Zernio (docs) |
|---|---|---|
| 1 | IG comment-to-DM with follow gate and URL buttons | Partial: documented, but Instagram now refuses buttons to non-followers; needs live test |
| 2 | Keyword matching (case and substring) | Partial: substring and whole-word modes documented; case sensitivity not documented |
| 3 | IG Reels: `shareToFeed`, collaborators, trial reels | Supported |
| 4 | Per-platform metrics | Supported as documented; needs live test (IG `follows` null on Reels; TikTok extras on Business connections only) |
| 5 | TikTok privacy and AI label | Supported (Business connections: public videos only) |
| 6 | Webhook signatures and reliability | Supported: HMAC-SHA256 of the raw body, 7 attempts over ~51 h, redelivery; no signed timestamp |
| 7 | Coexistence with other DM tools | Not documented beyond Meta thread control; needs live test |

## Consequences

- New users start for free (two accounts), and a typical owner pays less.
- The learning loop gets richer data: metrics for posts not published through AttentionOS, LinkedIn analytics, and webhooks for posts, messages, comments and analytics.
- Scheduling is crash-safe on Zernio (idempotency keys); on Blotato, ambiguous failures are surfaced to the owner instead of retried.
- Instagram DM automation behaviour (items 1, 2, 7) isn't settled by the documentation and is listed as known limits in [the Zernio guide](../providers/zernio.md#verified-behaviour-and-known-limits). AttentionOS ships with the follow gate off, whole-word matching, case variants and post-scoped automations, which are safe on both providers whatever the live answer is.
- Zernio meters outbound DMs above 10,000 a month; AttentionOS reports the error in plain words.

## Alternatives considered

- **Blotato as the default.** Mature publishing, scheduling and comment-to-DM, but no free API trial, no LinkedIn analytics, analytics only for its own posts, a minimal DM webhook, and no scoped keys for agencies.
- **Direct platform APIs (Instagram Graph, TikTok, YouTube, LinkedIn).** No vendor fees, but each needs app review, token refresh and its own quirks; out of reach for v0.1 and for non-technical owners.
- **A manual-only publisher.** Kept as `providers.publisher: "manual"`: every post becomes assist (file plus caption to the owner).

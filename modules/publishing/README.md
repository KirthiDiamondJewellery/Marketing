# Publishing (Publisher agent)

Gets finished pieces out on the right platforms at the right time: never twice, never with a payload that would fail, and never beyond the autonomy the owner chose. Default module, setup level 3. Decisions: ADR-1, ADR-13, ADR-14.

## What it does

- **Week manifest.** `publishing_plan_week` slots finished pieces (a render plus captions) into each platform's cadence: local slot times, allowed days, `perWeek` and `maxPerDay`, skipping past slots and slots already taken. Dry run first; confirming asks for one approval for the week.
- **Payload gate before any API call.** `@attentionos/guardrails`' `validatePublishPayload` (accounts snapshot, capabilities, per-platform fields, media, schedule, trial-reel acknowledgement) plus the CTA rules here (Instagram caption contains the keyword; TikTok says "DM me WORD" or "link in bio").
- **Idempotent, resumable scheduling.** Every post has the key `post:<content id>:<platform>:<script version>` (unique in the database and sent to providers that support idempotency keys). The hand-off claims a row (`queued → publishing`) before calling the provider; crashes and timeouts are recovered without double posts. `publishing.publish-due` is safe to run any time.
- **Instagram assist (ADR-13).** Instagram main-feed posts default to `assist`: the owner gets the file and caption through the notifier outbox before the slot, posts with trending audio, and records the link with `publishing_mark_posted`. `instagram.autopost: true` switches it off.
- **Cross-post and backfill.** `publishing_cross_post` queues a reel that's on Instagram to other platforms, swapping the comment-keyword line for a tracked link line (or "link in bio" on TikTok).
- **Tracked links.** `utm_content=<prefix><keyword>_<post#>` (post number from `aos_next_counter`, once per piece), `utm_source=<platform>`, optional short links via the site's `POST /api/links`.
- **Trial reels (opt-in, off).** Seeded variations, a verify pass over the rendered files, the rolling 24-hour cap and a one-time proof lock that only a person can release.

## Jobs

| Job | Default schedule | What it does |
|---|---|---|
| `publishing.publish-due` | every 10 min | Approved drafts → queued → sent; assist reminders; status checks; recovers stale sends |
| `publishing.schedule-week` | Sun 17:00 (dry run) | Plans next week and sends the plan to the owner |
| `publishing.sync-accounts` | daily 06:15 | Refreshes the accounts snapshot; alerts on accounts needing reconnection |
| `publishing.cross-post` | on demand | Cross-post / backfill |
| `publishing.schedule-trial-reels` | on demand | Opt-in trial reels |
| `publishing.post-event` | webhook | Applies provider `post.*` events |

## MCP tools

`publishing_plan_week`, `publishing_validate_payload`, `publishing_schedule_post`, `publishing_list_scheduled`, `publishing_cancel_post`, `publishing_build_tracked_link`, `publishing_cross_post`, `publishing_mark_posted`, `publishing_confirm_trial_proof`.

## Settings (`modules.publishing.settings`)

| Key | Default | Meaning |
|---|---|---|
| `cadence.<platform>` | see `DEFAULT_CADENCE` | `{ perWeek, days, slots: ["HH:MM"], maxPerDay }`; presets override it |
| `leadMinutes` | 15 | Slots closer than this are skipped |
| `instagram.autopost` | false | ADR-13 toggle |
| `instagram.assistLeadMinutes` | 60 | When the assist reminder goes out |
| `tracking` | `social` / `organic`, short links off | UTM medium and campaign; `shortLinks`, `linkApiPath`, `defaultDestination` |
| `crossPost` | TikTok, YouTube, Facebook, LinkedIn | Target platforms, `linkLine` (`{link}`), `linkInBioLine` |
| `trialReels` | off | `enabled`, `dailyCap` (50), `variationsPerReel`, `window`, `hashtagsPerPost` |

Secrets: `LINKS_API_TOKEN` (short links).

## Approval and autonomy

`review_all` (default): every post (or the week plan) waits for a person in the approvals queue. `review_key`: only bottom-of-funnel and offer posts wait. `autopilot`: posts go out and are reported. Approvals are always decided by a person (`core_decide_approval`, Telegram, Studio).

## For the worker

Exports `applyPublishEvent(ws, event)` and `publishDue(ws)`. Shared helpers used by the community module: `gate`, `notify`, `activity`, `trackingFor`, `ensurePostNumber`.

# Publishing

The Publisher gets approved work onto every platform you use, on schedule, without ever posting something twice.

| | |
|---|---|
| Agent | Publisher (`Pb`) |
| Tier | Default (on after setup) |
| Setup level | [Level 3](../setup/level-3.md) |
| Needs | A publisher: [Zernio](../providers/zernio.md) (default), [Blotato](../providers/blotato.md), or `manual` |
| Brand Kit files | `brand/brand.yaml` (handles, site URL, `utm_content` prefix) |

## What it does

### Week manifest and payload validation

- Each post is checked against a snapshot of your connected accounts and each platform's required fields **before** any API call.
- A **dry run** comes first. **Idempotency keys** mean nothing is posted twice, and the scheduler can resume after an interruption.

### Cadence and slots

How often you post and at what times, per platform, comes from your preset and lives in your config. Change it in plain words through the Publisher.

### Instagram main feed: assist by default

Trending audio can't be added through any API. So for your Instagram feed, the Publisher sends you the finished file and caption at the right time and you post it yourself. Autopost is one setting away if you don't need trending audio.

### Cross-posting and backfill

Queue a reel that's already on Instagram to every other platform. Comment-keyword calls to action are swapped for a link line where comment DMs aren't available.

### Tracked links

Every post gets `utm_content=<keyword>_<post number>`, and optionally a short link on your own site, so you can trace a lead or sale back to the post that produced it.

### Trial reels

Instagram trial reels are made and scheduled by the [trial-reels](trial-reels.md) module; publishing posts them with `options.instagram.trialReel` (never shared to the feed, graduation manual unless the owner turns on automatic), and holds the per-account proof check (`publishing_confirm_trial_proof`, people only).

## What you'll see

- `/attention:publish` in Claude Code.
- Scheduled posts in the approvals queue and in your publisher's dashboard.
- "Time to post" messages for Instagram feed posts in assist mode.

## Approvals

At `review_all`, every post waits for approval. At `review_key`, only campaign posts wait.

## Settings

`providers.publisher` chooses the service. `modules.publishing.settings` holds cadence, slots and per-platform options such as Instagram autopost.

## Limits

- Some fields can't be changed after posting on some platforms (for example TikTok captions). The validator catches what it can beforehand.
- The `manual` publisher exports files and captions and notifies you; nothing is sent automatically.

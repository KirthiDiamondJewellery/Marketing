# Research

The Analyst's research module answers one question every day: **what is working right now, for you and for your niche?**

| | |
|---|---|
| Agent | Analyst (`An`) |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) |
| Needs | A database; a scraper (Apify, Instagram Graph API or yt-dlp) for competitors; your publish provider's analytics for your own posts |
| Brand Kit files | `brand/competitors.yaml`, `brand/sources.yaml` |

## What it does

### Your own posts

- Imports your posts and their numbers from your publisher's analytics (Zernio by default), and keeps snapshots over time.
- Can backfill your full Instagram history through the Instagram Graph API.
- Collapses trial-reel variants of the same video into one, using the transcript.
- Accepts a CSV import for numbers no API exposes, such as Instagram skip rate.

### Competitor outliers

An **outlier** is a post that beat its creator's normal by a wide margin. Judging against each creator's own baseline controls for audience size, so a small account's breakout counts as much as a big account's.

- **Baseline:** the median of the creator's mature posts (at least 48 hours old). Pinned posts and posts older than 120 days are left out.
- **Score:** `x = metric ÷ baseline`. On Instagram the metric leans on comments (70% comments, 30% views), because comments track real interest. On TikTok it leans on views.
- **Floors:** an outlier also has to clear an absolute bar (for example at least 50 comments on Instagram, or 20,000 views on TikTok). Clips under 12 seconds are treated as memes and skipped.
- **Trends:** a topic is a trend when it is an outlier for two or more of the creators you track.
- **Rotation:** creators are scanned on a daily rotation, so scraping cost stays flat however many you track.
- **The spoken hook:** winners are transcribed so the hook you study is what was *said*, not just the caption. The most-liked comments ("comment gold") are kept too.
- **Visual tags:** a six-frame contact sheet is tagged for format, first-frame style, production level and words per second.
- **Budget guard:** provider spend is checked **before** each scan. If a scan would go over budget, you get an alert instead of a bill.

### Trend radar

- Sources are set per niche in `brand/sources.yaml`: RSS feeds, Google News searches, Reddit, Hacker News, GitHub, and (planned) X through Apify.
- Each item gets a **heat** score from how fast it is gaining attention, with a bonus for small accounts and decay with age. Daily and per-run caps stop it flooding you; a follow-up fires if a story's velocity doubles.
- Scraped text is **untrusted**. It only ever goes to a model call with no tools, and the output passes a deterministic validator before it is saved.
- The result is a **filmable kit**: a header, beats matched to screenshots or clips, a caption and a keyword.

### Teardowns

On request, the Analyst breaks down any post: transcript, frames, the hook frame by frame, pacing, caption style, the creator's signature move, and a clear "what's theirs, don't copy" section. After three or more teardowns of one creator, it writes a style fingerprint.

Every teardown also writes a **remix blueprint**: the opening line exactly as said, every beat in order with rough timing and what it does, the format and look, how the ending asks for action, why it worked, and everything that belongs to the creator (names, handles, brands, products, catchphrases, their numbers and stories). It's what the Copywriter remakes the post from, so it never has to read someone else's transcript. Code checks each blueprint before it's saved: the hook line must really be in the post, and no field may carry a link, a handle or anything that reads like an instruction. A teardown whose answer misses the expected format is retried, and a remix waiting on it asks for it again, so one bad answer never leaves a remix without its blueprint.

You don't have to ask. After each scan, the winners that get transcribed are torn down automatically (`competitorScan.autoTeardown`, on by default), and so are a couple of your own best posts per scan (`competitorScan.ownTeardownsPerScan`, default 2), so most proven posts are ready to remix by the time the Strategist plans the day.

## What you'll see

- New outliers and hot trends in the morning brief.
- Outlier hooks feeding the competitor hook bank used by the Copywriter.
- `/attention:research` in Claude Code to run a scan, add creators or request a teardown.

## Approvals

Research only reads; it never posts. Adding a creator or source changes your Brand Kit, which you approve.

## Settings

Set under `modules.research.settings` in `config/attentionos.config.ts`. Typical settings include how many creators to scan per day, outlier thresholds per platform, and trend caps. Schedules can be overridden under `modules.research.schedules`.

## Limits and notices

- **Platform terms.** Reading public posts through a third-party service may conflict with a platform's terms. You acknowledge this once before the first scan. AttentionOS never logs in as you and never automates a browser.
- Instagram Graph API only reads business and creator accounts.
- Numbers from scraped posts are snapshots; they change after the scan.

# ADR-9: Apify for competitor data, Instagram Graph API fallback, yt-dlp for TikTok and YouTube

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

Competitor outlier research needs public post metrics, captions and comments for Instagram and TikTok. Official APIs cover only part of this; browser automation is fragile and risky.

## Decision

- **Apify** is the default scraper, with spend checked against a monthly budget **before** every scan, and a daily creator rotation to keep cost flat.
- The **Instagram Graph API** (`business_discovery`) is the free fallback for Instagram business and creator accounts.
- **yt-dlp** covers TikTok and YouTube downloads for teardowns and transcripts.
- A platform-terms notice must be acknowledged before any scraping.
- No browser automation of social platforms.

## Consequences

- Reliable data for most users at low cost; free paths exist.
- Dependence on third-party actors that can change; adapters isolate the impact.
- Graph API data lacks competitor views, so Instagram scoring leans on comments.

## Alternatives considered

- **Browser automation.** Fragile, risky for users' accounts, and excluded by policy.
- **Graph API only.** Free, but misses TikTok and non-business accounts.

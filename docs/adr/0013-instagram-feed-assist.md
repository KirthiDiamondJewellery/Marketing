# ADR-13: Instagram main feed defaults to "assist", with an autopost toggle

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

Trending audio is a meaningful reach lever on Instagram, and no publishing API can add it. Posting a reel without it, automatically, can cost reach the owner would have had by posting by hand.

## Decision

- For the Instagram main feed, the Publisher defaults to **assist**: at the scheduled time the owner receives the finished file and caption in their notifier and posts it themselves.
- **Autopost** is one setting away for owners who don't use trending audio.
- Other platforms autopost by default once approved.

## Consequences

- Better reach where it matters most, at the cost of about 30 seconds of the owner's time per post.
- Posts in assist mode are tracked with the `assist` status, so metrics and attribution still work.

## Alternatives considered

- **Autopost everywhere.** Simpler, but gives up trending audio.
- **Browser automation to add audio.** Excluded by policy.

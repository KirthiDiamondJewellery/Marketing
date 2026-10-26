# ADR-14: Trial reels and scraping are opt-in with notices; no browser automation

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

Some features carry platform risk: scraping public posts, automated DMs, and Instagram trial-reel strategies. Browser automation of social platforms risks users' accounts and breaks often.

## Decision

- **Scraping**, **automated DMs**, **trial reels** and the **Remotion motion engine** require a one-time acknowledgement stored in config (`acknowledgements.*`) before they run.
- Trial reels are **off by default** and ship with seeded variations, a verify pass, a daily cap and a one-time proof lock.
- **No browser automation** of social platforms, anywhere in the engine. All platform actions go through APIs.

## Consequences

- Users make an informed choice, and the record of it lives in their config.
- Some capabilities available to browser-driven tools are deliberately out of scope.

## Alternatives considered

- **On by default with a terms link.** Too easy to miss.
- **Browser automation as a fallback.** Fragile and risky for users' accounts.

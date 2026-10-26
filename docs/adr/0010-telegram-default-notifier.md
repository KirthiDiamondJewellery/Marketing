# ADR-10: Telegram default notifier, Discord adapter, email digest

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

The Chief of Staff needs a channel the owner already checks on their phone, with buttons for approvals, file delivery for video review, and replies for revisions. It must work on a home machine without a public address.

## Decision

- **Telegram** is the default: inline buttons, file delivery, reply-to-message, and long polling (no public URL needed).
- **Discord** is a supported adapter. Without a public interactions endpoint it uses reactions and typed commands; with the Autopilot worker's endpoint it shows real buttons.
- **Email** is planned as a digest channel.
- All channels sit behind one `Notifier` interface and a channel-agnostic **outbox** (`messages`), with dedupe keys, quiet hours and alert dedupe in `alert_log`.
- Only messages from the configured chat, channel or owner are accepted.

## Consequences

- Zero-infrastructure setup for most users.
- Channel features differ; the outbox and routing must degrade gracefully (for example reactions instead of buttons).

## Alternatives considered

- **Slack.** Common in teams, but less common for solo owners and requires app review for some features.
- **SMS.** Costly, no buttons or files.
- **Email only.** Too slow for approvals and revision loops.

# ADR-2: Layered product with one data layer

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

AttentionOS has to be useful to a non-technical owner on day one, within a two-week window to `v0.1`, and still grow into a background system with a dashboard. Building the dashboard and worker first would delay the first useful release; building only chat-driven tooling would leave no path to automation. Every surface (Claude Code, Telegram, a future dashboard, the worker) needs to see the same state and obey the same rules.

## Decision

Ship in layers:

1. **First:** the Claude Code plugin (skills, subagents, `/attention:*` commands, hooks) and the CLI (`create`, `init`, `doctor`).
2. **On top:** the Autopilot worker and the Studio dashboard. These were first planned for v0.2 and v0.3; both ended up shipping in v0.1, with Studio as the main way to use AttentionOS day to day.

All layers share **one data layer**: repositories in `@attentionos/core`, exposed to agents as tools on one MCP server. Writes are attributed to an actor (`agent:<key>`, `user:<id>` or `system`), and rules such as keyword collisions, idempotency and approval checks live inside the tools.

## Consequences

- Users get value from Level 1 before any worker or dashboard exists.
- Adding a surface never means re-implementing rules; it means calling the same tools.
- The MCP tool surface becomes a public contract and needs versioning care.
- Copilot depends on the user having Claude Code installed.

## Alternatives considered

- **Dashboard first.** More approachable visually, but slow to build and useless without the data and agents behind it.
- **Separate data access per surface.** Faster to start, but rules would drift between surfaces and approvals could be bypassed.

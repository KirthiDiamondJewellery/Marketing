# ADR-3: Background AI work on the user's own Claude Code; API key optional

- **Status:** Accepted, as revised on 2026-10-10. The original decision (Autopilot only on an API key) and its rejection of background agents on the user's Claude login are **superseded** by the revision; they're kept below for the history.
- **Date:** Recorded 2026-10-11 (the original decision and its 2026-10-10 revision were written up together)
- **Deciders:** Maintainers

**Current position, in short:** the worker runs the user's own Claude Code CLI, signed in with the user's own `claude setup-token` login, on the user's own machine or server, for the user's own use. The project doesn't offer a claude.ai login to anyone. Users are responsible for using their plan within Anthropic's terms, and the API engine is always available. See [Revision 2026-10-10](#revision-2026-10-10).

The sections up to the revision are the original decision, titled "Copilot on the user's Claude Code; Autopilot on the Agent SDK with an API key".

## Context

Most owners already pay for a Claude plan and are comfortable in a conversation. Some want work to happen in the background on a schedule. Anthropic's Agent SDK terms state: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* ([source](https://code.claude.com/docs/en/agent-sdk/overview))

## Decision

Two compliant modes, sharing skills, the MCP data server and the database:

- **Copilot (Levels 1–3):** an AttentionOS plugin for Claude Code, run by the user in their own Claude Code with their own login.
- **Autopilot (Level 4):** a background worker on the Claude Agent SDK (TypeScript) that authenticates with the user's `ANTHROPIC_API_KEY`.

Model routing is configurable per agent. Every run has allowed and denied tools, a workspace file-system scope, `maxTurns`, a timeout and a dollar budget. Untrusted text only reaches tool-less calls with validated output. The product is described as "Powered by Claude" and never called "Claude Code".

## Consequences

- No reliance on claude.ai login for background work. *(Superseded: see the revision.)*
- Skills must be written to work in both modes, referencing tools by the same names.
- To keep tool names identical (`mcp__attentionos__*`), the MCP server is configured in the workspace's `.mcp.json` rather than bundled in the plugin, where it would be renamed and run from the plugin's folder.
- Autopilot costs are pay-per-use and need budgets and a cost watch.

## Alternatives considered

- **Autopilot only.** Simpler, but forces an API bill on every user from day one.
- **Background agents on the user's Claude login.** Rejected at the time, on the reading that the terms above rule it out. *(Superseded: the revision adopts this for software the user runs themselves, and explains why.)*

## Revision 2026-10-10

### Context

AttentionOS is open-source software that each person installs and runs for themselves, on their own machine or VPS. Nobody signs in to an AttentionOS service, and the project doesn't offer anyone a Claude login. A person can already run Claude Code headless (`claude -p`) on their own computer, on their own plan. Asking every user to also create and pay for an API key before anything runs in the background was the biggest setup hurdle at Level 4.

### Why the decision changed

The original decision read the quoted term broadly, as ruling out any background work on a Claude subscription. On review, the maintainers read it as being about third-party developers **offering** claude.ai login or rate limits in their products, for example a hosted service that signs people in with their Claude account. AttentionOS doesn't do that:

- There's no AttentionOS service, account, proxy or shared login. Each person runs the software on hardware they control.
- The worker starts the user's own installed Claude Code CLI (`claude -p`), the same command the user can run in a terminal. It signs in with a token the user creates themselves (`claude setup-token`) and keeps in their own `.env`.
- The work it does is the user's own: their brand, their accounts, their Claude plan.

This is the maintainers' reading of the terms, not legal advice, and the terms or plan policies may change. Users are responsible for using AttentionOS within Anthropic's terms for their plan. Anyone who is unsure, or whose plan doesn't cover this use, can switch to the API engine (`runner: { engine: "api" }`) with their own API key; skills, tools and safety rules are the same on both.

### Decision

- **Background AI work runs on the user's own Claude Code CLI by default.** The worker spawns the user's signed-in `claude -p --output-format stream-json` on the same machine, with the AttentionOS MCP server attached as a stdio child pinned to the agent. No API key is needed. This is the `"claude-code"` engine: `runner: { engine: "claude-code", claudeBin? }` in `config/attentionos.config.ts`.
- **The API engine stays as an option.** `runner: { engine: "api" }` runs the Claude Agent SDK with `ANTHROPIC_API_KEY`, billed per use, with per-run and daily dollar caps.
- **`mode` now describes when AI work runs, not how:**
  - `"copilot"` (shown in Studio as "On request"): AI work runs when the user asks (Studio chat, Run now, approvals, Claude Code, Telegram).
  - `"autopilot"`: the worker also runs scheduled AI jobs.
  - Both need the worker running (`./aos start`) for work started from Studio. Scheduled data jobs with no model (syncs, scoring) run in either mode.
- Users run AttentionOS on their own Claude account and are responsible for using it within the terms of their own plan.

### Consequences

- Level 4 needs one sign-in, not two: `claude` signed in on the machine that runs the worker. `attentionos doctor` checks `claude auth status`.
- A VPS or container must have Claude Code installed and signed in: `claude setup-token` on a computer with a browser, then `CLAUDE_CODE_OAUTH_TOKEN` in the server's environment (never baked into an image), or `claude` run once over SSH.
- Runs on the Claude Code engine aren't billed per run, so nothing is written to `cost_ledger`. Studio shows "Used N steps on your Claude plan". Turn limits and timeouts still apply to every run; dollar budgets apply to the API engine only.
- Usage counts against the user's Claude plan limits. Heavy Autopilot schedules can hit those limits; the API engine is the way out.
- MCP servers for the CLI engine must be stdio, since an in-process server can't cross the process boundary.
- Skills, tool names (`mcp__attentionos__*`) and safety rules are identical on both engines.

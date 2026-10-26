# How your agents run

AttentionOS is open-source software you run yourself, on your own computer or your own server. Its agents do their AI work through Claude. Two settings decide how that happens:

- **The engine** decides *what* runs the AI work and who pays for it: your own Claude Code (the default) or an Anthropic API key.
- **The mode** decides *when* AI work runs: only when you ask ("On request"), or also on a schedule ("Autopilot").

Every combination uses the **same skills**, the **same data server** and the **same database**, so you can switch at any time without redoing anything.

## Engines: what runs the AI work

| | **Claude Code** (default) | **API key** (optional) |
|---|---|---|
| What it is | Your own Claude Code, signed in on the machine that runs AttentionOS. The worker runs it in the background (`claude -p`), the same way you could run Claude Code yourself | The Claude Agent SDK, inside the worker, using an Anthropic API key you create |
| What you need | Claude Code installed and signed in with your Claude account | `ANTHROPIC_API_KEY` in your workspace `.env` |
| Cost | Included in your Claude plan. Nothing is billed per run; Studio shows "Used 12 steps on your Claude plan" | Pay per use. Targets: about $0.50–$1 a day for research plus the brief; under $0.50 per reel edit |
| Limits | Your Claude plan's usage limits | Daily and per-run dollar caps you set |
| Good for | Most people: one sign-in, no extra bill | Heavy schedules that would hit your plan's limits, or a server where you'd rather not sign in to Claude |

Pick the engine in `config/attentionos.config.ts`:

```ts
runner: { engine: "claude-code" },  // the default; or "api" to use ANTHROPIC_API_KEY
```

If `claude` isn't on your `PATH`, point to it with `claudeBin: "/path/to/claude"`.

You run AttentionOS on your own Claude account, and it's up to you to use it within your plan's terms.

## Modes: when AI work runs

| | **On request** (`mode: "copilot"`) | **Autopilot** (`mode: "autopilot"`) |
|---|---|---|
| When AI work runs | Only when you ask: Studio chat, **Run now**, approvals, Claude Code, Telegram | When you ask, **and** on its own schedule: research overnight, the morning brief, DM triage as messages arrive |
| Background data jobs (syncs, scoring) | Run on schedule | Run on schedule |
| Good for | Getting started; staying in control of your plan's usage | Research and syncs while you sleep, edits started from your phone |

Change the mode in Studio under **Settings → Workspace** (**How your agents run**), or in `config/attentionos.config.ts` (`mode: "copilot"` or `mode: "autopilot"`).

Both modes need AttentionOS running for work you start from Studio or Telegram:

```
./aos start
```

It keeps running in Docker, on your computer or on a server ([docs/deploy/server.md](deploy/server.md)). Work you start inside Claude Code runs in Claude Code itself and doesn't need it.

## What each setup needs

| You want | Engine | Mode | Needs |
|---|---|---|---|
| Use AttentionOS inside Claude Code only | any | any | Claude Code with the AttentionOS plugin (Levels 1–3) |
| Studio chat and Run now on your computer | Claude Code | On request | Claude Code signed in, AttentionOS running (`./aos start`) |
| Hands-off daily work on your computer | Claude Code | Autopilot | The above, and your computer awake |
| Hands-off daily work on a server | Claude Code | Autopilot | Claude Code installed and signed in on the server ([VPS guide](deploy/server.md#sign-in-to-claude)) |
| Metered billing instead of your plan | API | either | `ANTHROPIC_API_KEY` in `.env` |

`./aos doctor` checks that Claude Code is installed and signed in (and, on the API engine, that the key is set).

## Inside Claude Code

1. Your workspace's `.claude/settings.json` recommends the AttentionOS plugin and pre-approves the workspace's data server, so opening the folder in Claude Code offers to install everything.
2. The plugin adds:
   - **commands**: `/attention:init`, `/attention:brief`, `/attention:research`, `/attention:script`, `/attention:edit`, `/attention:publish`, `/attention:inbox`, `/attention:approvals`, `/attention:learn`, `/attention:doctor`, `/attention:lesson`;
   - **subagents**: `attention:analyst`, `attention:strategist`, `attention:copywriter`, `attention:art-director`, `attention:publisher`, `attention:community` and `attention:chief-of-staff`, each limited to the tools its job needs;
   - **skills** from every module;
   - **hooks**: a copy guard that checks Brand Kit and content files after each write, and a session-start summary of approvals waiting.
3. The workspace's `.mcp.json` starts the AttentionOS data server (`attentionos mcp`, inside the stack). Its tools are named `mcp__attentionos__<tool>`, exactly as in the worker, so skills work the same everywhere.

Install by hand, if needed:

```
/plugin marketplace add evanbaker315/AttentionOS
/plugin install attentionos@attentionos
```

## Inside the worker

1. The Docker stack (`./aos start`) runs Studio and the worker: a scheduler and a job queue in your database.
2. **Native jobs** (sync, scoring, finishing, QC, the brief composer) run as plain code and never use Claude.
3. **AI jobs** run through one runner on your chosen engine, with a turn limit, a timeout and resumable sessions for revisions. On the Claude Code engine, each job starts your `claude` with the AttentionOS data server attached and limited to that agent's tools. On the API engine, each job also has a dollar budget and its cost is recorded.
4. Webhooks from your publisher (posts, messages, analytics) trigger work immediately.
5. Results land in the same approvals queue you see in Studio, Telegram, Discord and Claude Code.

## Model routing

Configurable per agent in `config/attentionos.config.ts`:

```ts
agents: {
  community:  { model: "sonnet" },  // bulk triage and captions
  copywriter: { model: "opus" },    // scripts
  art_director: { model: "opus" },  // edit plans
},
```

A Sonnet-class model handles bulk work (triage, tagging, captions). An Opus-class model handles scripts and edit plans. Native jobs use no model at all.

## Safety on every run

- **Allowed and denied tools** per job, and a file-system scope limited to your workspace, on both engines.
- **Turn limits and timeouts** on every run. On the API engine, a **dollar budget** per run plus a daily ceiling.
- **Untrusted text** (scraped posts, DMs, comments, trend items) only goes to model calls with **no tools**, and their output is checked by a validator before it's used.
- **Deterministic gates** in code (script validator, keyword ledger, payload validator, export QC) that a model can never edit.
- **Autonomy per agent.** Nothing goes public beyond the level you choose: `review_all` (default), `review_key` or `autopilot`.

## Which should I choose?

Start with the **Claude Code** engine and **On request**. It runs on the Claude plan you already have, and you'll learn how the team works. Switch to **Autopilot** when you want research and syncs to happen while you sleep. Switch to the **API** engine only if your schedule outgrows your plan's limits or you'd rather pay per use.

## Naming

AttentionOS is **Powered by Claude**. It's an independent open-source project, not a Claude Code product, and it isn't made or endorsed by Anthropic.

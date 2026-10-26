# Ops

The Chief of Staff is your single point of contact with the agent team. It writes the morning brief, carries the conversation in Telegram or Discord, keeps the approvals queue, routes your messages to the right agent, and stays quiet when you've asked it to.

| | |
|---|---|
| Agent | Chief of Staff (`Cs`) |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) |
| Needs | A database; a notifier: [Telegram](../providers/telegram.md) (default), [Discord](../providers/discord.md) or `console` for development |
| Brand Kit files | None directly; it reports on everything else |

## What it does

### Morning brief

Every morning (07:30 in your timezone by default) you get one message that combines:

- today's "Film today" pieces from the [strategy](strategy.md) module;
- **approvals waiting** for you, oldest first;
- **yesterday's results**: posts published, their early numbers, new leads;
- **alerts**: disconnected accounts, budgets running low, failed jobs, in plain language.

The brief is built by a **deterministic composer with no model at all**, so it arrives even when no model is available, costs nothing, and never makes anything up. In Claude Code, `/attention:brief` adds the Chief of Staff's commentary on top.

### Chat

Talk to your team from Telegram (default) or Discord.

| You send | What happens |
|---|---|
| Press **Approve** or **Reject** under an item | The approval is decided and the agent continues |
| `approve ap-7` | Approves item `ap-7` |
| `reject ap-7 too salesy` | Rejects it, and the note goes back to the agent |
| A reply to an edit, or `rf-12 v2 tighten the intro` | Queues a revision of edit `rf-12` with your notes |
| `brief` | Sends the morning brief now |
| `approvals` | Lists what's waiting for you |
| `quiet 21:30-07:00` or `quiet off` | Sets or clears quiet hours |
| `demo on` or `demo off` | Turns demo mode on or off |
| `help` | Lists these commands |
| Anything else | Goes to the Chief of Staff, who answers or hands it to the right agent |

Only messages from your own chat (Telegram chat id, or the Discord channel and owner you configured) are accepted.

### Approvals queue

Every surface (Claude Code, Telegram, Discord, and later Studio) reads **one** approvals queue. Each item has a short reference like `ap-7`, a one-line summary, a preview, and the agent that asked. Decide it anywhere; it's decided everywhere.

### Quiet hours

During quiet hours, normal and low-priority messages are held and delivered when the window ends. High-priority alerts (for example "Instagram disconnected; posts are paused") still go out. Set them with `quiet 21:30-07:00` in chat, the `quietHours` setting in your config, or the Chief of Staff's tool.

### Alert dedupe

The same alert is never sent twice within a window (3 hours by default, `modules.ops.settings.alertDedupeMinutes`). It is counted instead, so the next one tells you how many times it happened.

### Outbox

Every message goes through one outbox. Messages are queued, delivered by the dispatcher, and deduplicated, so a restart never sends the same message twice, and a channel outage just means a short delay.

### Demo mode (reel mode)

Masks names and handles in everything the agents show you while **keeping the numbers real**, so you can film your screen or present the product safely.

## Jobs

| Job | When | What it does |
|---|---|---|
| `ops.write-morning-brief` | Daily at 07:15 (Autopilot) | The Chief of Staff writes the brief from today's data |
| `ops.morning-brief` | Daily at 07:30 | Sends the plain, no-AI brief if the written one didn't go out (one brief per day, never two) |
| `ops.dispatch-outbox` | Every minute | Posts new approvals with buttons, then delivers queued messages, respecting quiet hours and dedupe |
| `ops.poll-inbound` | Every minute | Reads your replies and button presses and routes them |
| `ops.chief-of-staff` | When you send free text | Answers you or hands the request to the right agent |

In Copilot mode, the scheduled jobs run when you use the commands or call `attentionos run <job>`; in Autopilot they run on schedule.

## Tools

Available to Claude as `mcp__attentionos__<tool>`:

| Tool | What it does |
|---|---|
| `ops_get_morning_brief` | Returns today's brief |
| `ops_list_approvals` | Lists items waiting, with their `ap-` references |
| `ops_decide_approval` | Approves, rejects or asks to revise an item by reference, with an optional note |
| `ops_send_notification` | Sends you a message through your notifier |
| `ops_set_quiet_hours` | Sets or clears quiet hours |
| `ops_set_demo_mode` | Turns demo mode on or off |
| `ops_process_chat` | Pulls new Telegram or Discord replies and routes them |

## What you'll see

- The brief every morning, and on demand with `/attention:brief`.
- `/attention:approvals` in Claude Code.
- A short list of pending approvals when you start Claude Code in your workspace.

## Settings

| Setting | Where | Default |
|---|---|---|
| Notifier | `providers.notifier` | `telegram` |
| Quiet hours | `quietHours: { start, end }` | none |
| Brief time | `modules.ops.schedules["ops.morning-brief"]` (and `"ops.write-morning-brief"`), cron in your time zone | `30 7 * * *` |
| Alert dedupe window | `modules.ops.settings.alertDedupeMinutes` | 180 |
| Demo mode default | `modules.ops.settings.demoMode` (the `demo on/off` command overrides it) | off |
| Approvals listed in the brief | `modules.ops.settings.briefApprovals` | 5 |
| Post each new approval to chat | `modules.ops.settings.notifyApprovals` | on |
| Delivery attempts before giving up | `modules.ops.settings.maxSendAttempts` | 5 |

## Limits

- Discord buttons need an interactions endpoint, which only the Autopilot worker provides. Without it, Discord uses reactions (✅ approve, ❌ reject) and typed commands.
- Demo mode masks what AttentionOS shows; it can't mask what's inside your raw footage.
- If a chat app refuses a file (too large, for example), the message still arrives, with a note saying where the file is in your workspace.
- A paused task that needed your approval picks up again automatically once you decide (other modules use this to schedule, send or re-cut after your yes).

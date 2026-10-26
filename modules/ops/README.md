# Ops: the Chief of Staff

Core module, setup level 1. The Chief of Staff is your single point of contact: it sends the morning brief,
keeps the approvals queue, talks to you over Telegram or Discord, respects your quiet hours, avoids repeat
alerts, and can hide names when you film the product.

User guide: [docs/modules/ops.md](../../docs/modules/ops.md). This page is for contributors.

## What's in here

| Path | What it does |
|---|---|
| `src/lib/brief.ts` | Deterministic morning-brief composer (no LLM) and the session-start summary |
| `src/lib/brief-data.ts` | Loads the brief's facts: film today, approvals, scheduled posts, results, alerts, spend |
| `src/lib/approvals.ts` | List and decide approvals; resume paused runs; approval chat messages with buttons |
| `src/lib/router.ts` | Pure chat routing: buttons, `approve ap-7`, `rf-123 v2 <notes>`, replies, short commands |
| `src/lib/chat.ts` | Applies routed intents; records every inbound message once; queues replies |
| `src/lib/outbox.ts` | The `messages` outbox: enqueue with dedupe keys, dispatch with quiet hours, retries, alerts |
| `src/lib/quiet-hours.ts`, `src/lib/alerts.ts`, `src/lib/time.ts` | Quiet-hours windows, `alert_log` dedupe decisions, time-zone helpers |
| `src/lib/mask.ts` | Demo (reel) mode: consistent fictional names and handles; numbers untouched |
| `src/jobs/` | `ops.morning-brief`, `ops.write-morning-brief`, `ops.dispatch-outbox`, `ops.poll-inbound`, `ops.chief-of-staff` |
| `src/tools/` | MCP tools: `ops_get_morning_brief`, `ops_list_approvals`, `ops_decide_approval`, `ops_send_notification`, `ops_set_quiet_hours`, `ops_set_demo_mode`, `ops_process_chat` |
| `skills/` | `morning-brief` and `owner-chat`, shipped in the Claude Code plugin |

## Contracts other modules rely on

- **Approvals.** Insert an `approvals` row (`ref` from `aos_next_counter(ws, 'ap')`, formatted `ap-<n>`) with
  `run_id` pointing at your run, and set the run to `waiting_approval`. Ops posts it to chat with approve and
  reject buttons. When the owner decides, ops sets the run back to `queued` with
  `input.approval = { ref, decision: "approve" | "reject" | "revise", note? }`. Your job reads that and acts.
- **Edit revisions.** A reply to a message whose `ref` is `rf-<n> v<k>`, or a typed `rf-<n> v<k> <notes>`,
  queues `editing.revise` (agent `art_director`) with input `{ ref, fromVersion, notes, attachments?, source }`.
  Send edit previews with `ref: "rf-12 v2"` so replies find their way back.
- **Notifications.** Use `enqueueMessage` (or the `ops_send_notification` tool). Give anything that could repeat
  a `dedupeKey`. Use `priority: "high"` only for things that can't wait until morning. Use `raiseAlert` for
  problems, so the same alert isn't sent more than once per window.
- **Session start.** The CLI's `attentionos hook session-start` should print `sessionStartSummary(ws)`.

## Settings

`config.modules.ops.settings` (see `src/settings.ts`): `alertDedupeMinutes` (180), `demoMode` (false),
`briefApprovals` (5), `dispatchBatch` (20), `maxSendAttempts` (5), `notifyApprovals` (true). Chat commands
override quiet hours and demo mode at runtime through the `settings` table (`ops.quiet_hours`,
`ops.demo_mode`); the inbound cursor per channel lives at `ops.inbound_cursor.<channel>`.

## Tests

```sh
pnpm exec vitest run modules/ops
```

Pure tests cover the composer, routing, refs, quiet hours, alert dedupe and masking. `db.integration.test.ts`
runs against a throwaway `attentionos_test_ops` database on `ATTENTIONOS_TEST_DATABASE_URL` (set it to the
`pnpm db:start` server, `postgresql://postgres:postgres@127.0.0.1:55433/postgres`) and is skipped when no server is
reachable.

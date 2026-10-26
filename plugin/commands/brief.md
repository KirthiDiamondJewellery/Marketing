---
description: Your morning brief, what to film today, what's waiting for approval and how yesterday went
allowed-tools: Read, Glob, Grep, mcp__attentionos__ops_get_morning_brief, mcp__attentionos__ops_list_approvals
---

# Morning brief

Give the owner their morning brief for today.

1. Call `ops_get_morning_brief` from the attentionos MCP server. It combines the daily "Film today" doc, approvals waiting, yesterday's results and alerts. If the server is unavailable, say so plainly and suggest `/attention:doctor`.
2. If the brief has no "Film today" items yet, check the `strategy_*` tools for today's daily brief. If none exists, offer to have the Strategist draft one now.
3. Present it in this order, short and scannable:
   - **Film today**: each piece with its header, why it was picked (lane, trend or outlier), the deadline ("film by"), and the shoot direction in one line.
   - **Waiting for you**: approvals by ref (`ap-7`), one line each.
   - **Yesterday**: what was published and how it is doing against the owner's own baseline (for example "2.4x your usual"). Never round up or invent numbers; quote what the tools return.
   - **Heads up**: alerts, such as a disconnected account or a budget nearly used.
4. Close with up to three suggested next actions, for example "Approve ap-7", "Write the script for the second idea" (`/attention:script`), or "Review the inbox" (`/attention:inbox`).

Keep it plain: show the work, not the wiring. Never mention job ids, run ids, tokens or model names.

Extra instructions from the owner, if any: $ARGUMENTS

---
description: See everything waiting for your sign-off and approve, reject or request changes by ref
argument-hint: "[ref, e.g. ap-7] [approve | reject | revise <notes>]"
allowed-tools: Read, Glob, Grep, mcp__attentionos__ops_list_approvals
---

# Approvals

The owner's input: `$ARGUMENTS`

## If no ref was given

Call `ops_list_approvals` from the attentionos MCP server and show the pending queue, oldest first:

```
ap-7   Script   Copywriter   "3 mistakes buyers make on day one"   waiting 2h
ap-8   Post     Publisher    Thursday 9:00 on Instagram + TikTok    waiting 20m
```

Offer to open any item to see its preview (script text, caption, edit output path, reply draft).

## If a ref and a decision were given

1. Show the item's summary and preview first, so the owner sees exactly what they are approving.
2. Confirm in one line ("Approve ap-7, the script for Thursday?") unless the owner was already explicit.
3. Call `ops_decide_approval` with the ref and `approve`, `reject` or `revise` plus the owner's note.
4. Report the outcome in plain words: "Approved ap-7. Copywriter will hand it to the Art Director for editing." For `revise`, say who will make the change.

If a rejection or revision note sounds like a lasting rule ("never open with a question"), offer to save it with `/attention:lesson`.

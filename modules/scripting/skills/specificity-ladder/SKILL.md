---
name: specificity-ladder
description: Climb every vague line in a script or post up the specificity ladder (vague, specific, concrete, lived) using real details from the proof inventory and the owner's own work. Use after drafting and before validating any script, caption or text post.
---

# Specificity ladder

Vague lines are skipped. Specific lines are believed. Aim for level 3 or higher on every line that carries the argument.

| Level | What it sounds like | Example (fictional physio clinic) |
|---|---|---|
| 1. Vague | A category and an adjective | "We help people recover faster." |
| 2. Specific | One named thing | "Every patient gets a home exercise plan." |
| 3. Concrete | A count, a time, a place, a thing you can picture | "Every patient leaves the first visit with three exercises and a check-in booked for day 10." |
| 4. Lived | A moment that only happened to this business | "On Tuesday a runner sent us a video of her first pain-free mile, two weeks before her race." |

## How to climb

1. Underline every category ("clients", "results", "a lot of time") and every adjective doing the work ("huge", "fast").
2. Replace categories with instances and adjectives with numbers or names, taken only from:
   - `brand/proof-inventory.yaml` (case studies, wins, FAQs, processes, builds);
   - the cited sources from `scripting_get_claim_sources`;
   - what the owner has told you in this session or wrote in `brand/lessons.md`.
3. Never invent the detail. If the specific version doesn't exist in a source, keep the line at level 2 and say plainly what you'd need from the owner to climb it.
4. Any number you add goes in the claim ledger (`claim-ledger` skill).
5. A client detail needs `clientConsent: true` on the proof item. Without it, describe the client by type, never by name or address.

## Check

Read each beat and mark its level. The hook, the proof and the play should all be level 3 or 4. If the whole script sits at level 2, the angle is too broad: pick one project, one moment, one number.

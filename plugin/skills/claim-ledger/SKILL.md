---
name: claim-ledger
description: Build the claim ledger for a script or post, marking every factual claim PASS, FIX or CUT with its source, so no number or fact ships without evidence. Use before validating any script, caption or text post that states a fact, price, number, capability or result.
---

# Claim ledger

Never invent a number. Every factual claim in the script gets a ledger entry, and the validator checks the ledger in code: every number said out loud must appear in a PASS entry whose source records that number.

## What counts as a claim

Prices ("free", "under ten thousand"), numbers and percentages, capabilities ("it can", "works with"), status ("new", "the first"), attribution (who made or said it), and first-person receipts ("we finished it in six weeks"). A receipt is a claim too: it must match the record.

## Allowed sources

Call `scripting_get_claim_sources`. It returns:
- **proof inventory items** from `brand/proof-inventory.yaml`, each with its recorded numbers. Cite as `proof:<id>`. These are the only source of numbers for proof content.
- **cited sources** attached to the content (trend items, research, links). Cite as `cited:<id>` or the https link.
- **spent stats**: numbers already used in recent scripts.

Training memory is not a source.

## Verdicts

- **PASS**: verified against the cited source exactly as stated. Use the number as recorded; don't round or upgrade it.
- **FIX**: it was wrong; correct the script, note the original and the correction, and add the corrected claim as its own PASS entry.
- **CUT**: can't be verified. Remove it from the script. The validator fails any script that still says a CUT number.

Entry shape: `{"id": "c1", "claim": "...", "verdict": "PASS", "source": "proof:<id>", "note": "..."}`. Give each entry an id: edit-plan overlays point at it as their evidence.

## Rules the validator enforces

- PASS and FIX need a source that exists. Numbers in a proof claim must be among that item's recorded numbers.
- **Single-source claims from outside the business are framed as theirs**: "they say", "according to <source>", "<source> found that". A claim confirmed by two independent sources may be stated plainly.
- **Known fake stats are always rejected**, whatever the verdict: the "10% of your brain" line, the goldfish attention span, the "8-second attention span", "93% of communication is nonverbal", "21 days to form a habit", and similar folklore.
- **Spent stats warn**: a number used in a recent script reads as filler to returning viewers. Prefer a different proof item.
- **The "free" trap**: only say free when the exact thing shown works at no cost, with no paid plan or key behind it.

## Before saving

Read the script and list every claim. Each one is in the ledger with a verdict and a source. Every CUT is gone from the script. Every outside single-source claim says whose claim it is.

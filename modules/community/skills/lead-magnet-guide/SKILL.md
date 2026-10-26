---
name: lead-magnet-guide
description: Write the lead-magnet guide for a keyword in the house format. One guide per keyword, solving one narrow problem completely, with an email gate and calls to action. Use when the user asks for a guide, a lead magnet, a freebie or "the thing people get when they comment".
---

# Lead-magnet guide

One keyword, one guide, one narrow problem solved completely. The guide is the first real thing a new lead gets from the owner, so it has to be useful on its own and lead naturally to the next step (usually a call).

Read first: `brand/offers.md` (what the owner sells, and the exact wording of offers, which you must never paraphrase), `brand/icp.md` (who reads this), `brand/voice.md` (how it sounds), `brand/proof-inventory.yaml` (the only allowed source of numbers).

## Gate questions (answer before writing)

1. Does it map to one of the owner's pillars (`brand/pillars.md`)?
2. Does the reader care about the outcome (a business result, not a technical setup)?
3. Is it one narrow problem, solved completely?
4. What next problem does solving it reveal? That's the bridge to the call.
5. Can every fact be checked today? If not, cut it.

Pick exactly one type: **reveal a problem**, **one step of many**, or **free sample**.

## Title

A short title, plus a sub line built on one formula: number + outcome + timeframe; how to X without Y; X mistakes; or adjective + good thing. Write three, pick the clearest. No numbers you can't prove.

## House format (checked when registered)

```markdown
# <Short title>

<Sub line.> One sentence that tells someone who commented the keyword they're in the right place.

## What's inside
- <four bullets, each a concrete thing they'll be able to do>

## What this is
<three short paragraphs: the problem, why it matters now, what this guide does about it>

## <The steps>
<numbered steps, tables and copy-paste templates where they help>

<!--CTA-->

## What this just showed you
<the next problem this reveals, and the honest next step: the owner's offer, in its exact wording>
```

- Everything above "What this is" plus a short peek of the steps stays public; the rest sits behind the email gate.
- One mid-guide call to action at the `<!--CTA-->` marker, and one at the end. Each has a clear action, the exact next step and a true reason to act now.

## Writing rules

- Plain words, short sentences, sentence-case headings, no ALL CAPS, no long dashes.
- Specific about the problems, modest about the results.
- No client names or results without consent; examples are labelled as examples and use round made-up numbers.
- Numbers only from `brand/proof-inventory.yaml` or a cited source.

## Register it

`community_register_lead_magnet` with the piece (or keyword), the title, and `bodyMd`. Fix every error it returns; read the warnings to the owner. Then hand over to the `keyword-dm-chain` skill for the automation.

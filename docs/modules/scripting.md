# Scripting

The Copywriter turns a picked idea into a script you would actually say, with a hook that has a known track record and claims that hold up.

| | |
|---|---|
| Agent | Copywriter (`Cw`) |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) |
| Needs | Your Brand Kit; research data for hooks |
| Brand Kit files | `brand/voice.md`, `brand/icp.md`, `brand/offers.md`, `brand/brand.yaml`, `brand/lessons.md` |

## What it does

### Copy what works (remix first)

If a reel pulled a million views, the fastest way to a good script is to remake it, not to reinvent it. Most scripts are **close remixes** of one proven post: a competitor's outlier, or one of your own breakouts ("do that again, new angle").

A remix keeps, almost exactly:

- the hook's pattern and near-same wording (only the topic words change);
- the beats in the same order, each doing the same job;
- the length and pacing;
- the format and look (talking head, green screen, split screen);
- how the ending asks for action.

It changes only what makes it yours: the topic specifics (moved to your offer and audience), the proof (your own example, and your numbers only from `brand/proof-inventory.yaml`) and the words (your voice, from `brand/voice.md`, `brand/lessons.md` and your own best posts).

**Never without its blueprint.** A remix is only written from its source's checked blueprint. If the teardown isn't in yet, the script waits for it in code (no AI time spent) and starts the moment it lands; a failed teardown is retried, and after two failures the script stops and tells you to pick another source rather than writing something generic. The working title becomes the blueprint's topic as soon as it's known.

Every remix says where it came from, next to the script in Studio: "Based on @handle's reel, 1.2M views, 14x their normal".

**How it stays safe.** Other people's transcripts and captions are untrusted text, so the Copywriter (which has tools) never reads them. A tool-less teardown reads the post and writes a **remix blueprint**: the hook line quoted exactly, the beats with timing, the format, the call-to-action mechanic, why it worked, and what belongs to the creator. Code checks the blueprint (the hook line must really be in the post; no links, handles or instructions) before the Copywriter sees it. The validator then keeps the creator's handle, name, brand, products, catchphrases and numbers out of your script, and fails a script that reads long passages of their transcript back after the hook.

**When you ask for a script about something** ("Ask the AI", or a planned talking head), the Copywriter first looks for proven posts on that topic (`scripting_find_remix_sources`) and adapts the best match when there is one, saying which. If nothing fits, it writes an original modelled on your own best posts.

**Your own best posts, every time.** Each brief carries your top posts against your own normal (the scripts of posts made here, and the hook lines and beats of your imported posts), so the words sound like you.

### Fast by design

Before the Copywriter starts, code gathers everything it needs into one work packet: the brief, the remix blueprint (or proven posts on the topic), your best posts, your Brand Kit text, the numbers it may use, free keywords and recent scripts. The Copywriter thinks once and drafts once, then saves. Saving runs every check and, when one fails, lists the exact fix, so a revision only sends the changed lines instead of retyping the script.

### Two hook banks

- **Your own bank:** openers from your posts that beat your median by 3× or more.
- **Competitor bank:** openers harvested from outliers, capped in size and decaying over time.

Both use a named pattern taxonomy. Every script records which hook it used and where it came from. Original scripts use a bank hook's structure with new words; a remix uses its source's hook, with only the topic words changed.

### Method

- A **voice profile** built from your own transcripts during the interview.
- A **hook audit**: four common hook killers plus an open-loop check.
- A **spoken humanizer** and a specificity ladder, so scripts sound like talking, not writing.
- **Gates**: close, never theirs (a remix keeps the source's structure but never the creator's identity, stories or numbers); broad versus insider stakes; a "feel seen, not blamed" test; never name a client without consent.

### The six-beat skeleton

Original scripts follow it. A remix follows its source's beats instead: it must open with the hook and end with the close, and may skip a beat the source didn't have.

1. **Hook:** the whole claim in the first 0–3 seconds.
2. **Turn:** why the obvious answer is wrong.
3. **Proof with a number**, from your proof inventory or a cited source.
4. **Rehook** at 25–40% of the way through.
5. **The play:** what to do.
6. **Close** that calls back to the hook.

### Claim ledger

Every factual claim is marked **PASS**, **FIX** or **CUT**, with its source. Known fake statistics and overused "spent" statistics are flagged. A claim with only one outside source gets "they say" framing; facts about your own offers (cited `offer:<id>`, or a link on your own site) are yours to state. Numbers only come from your data files or cited sources: **never invented**. When your proof inventory has no numbers yet, or the script is a remix whose source proved its point with a story or a demo, a proof beat without a number is a warning, not a failure.

### The validator

A hard gate in code that the model can never change. A script only reaches you when it passes:

- spoken words only, inside the length window;
- no banned openers or phrases from your Brand Kit;
- punctuation and capitalization policy;
- the call-to-action line matches the call-to-action type;
- 3–5 niche hashtags;
- the hook's source is recorded;
- the keyword is valid and unused;
- for a remix: written from the source's checked blueprint; none of the source creator's handle, name, brand, products or catchphrases; none of their numbers unless your proof inventory backs it; no long passage of their transcript after the hook. Its hook may run as long as the source's did, and its length window stretches to fit a longer source. Drifting from the source's hook, length or beat count is flagged as a warning.

### Captions per platform

From one transcript, captions for Instagram, TikTok, YouTube, Facebook, LinkedIn and X, each following that platform's rules.

### Text posts

A weekly batch for X, Threads and LinkedIn. LinkedIn long-form follows research → write → visual → a quality rubric (8 out of 10 overall, at least 7 on every criterion).

## What you'll see

- `/attention:script <idea or content id>` in Claude Code.
- Scripts in your approvals queue with the validator report and claim ledger attached.

## Approvals

Every script waits for approval at the default `review_all` level. Your edits are compared to the draft, and repeated corrections become rules in `brand/lessons.md`.

## Settings

`modules.scripting.settings` covers things like the length window and caption platforms. Banned phrases live in `brand/voice.md` and `bannedPhrases` in `brand/brand.yaml`.

## Credits

Some method files are adapted from MIT-licensed material; attribution is kept in the repository's `NOTICE` file.

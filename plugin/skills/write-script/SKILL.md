---
name: write-script
description: Write one short-form video script for a content item in the owner's own voice. Remix first (closely remake a proven post, a competitor's outlier or the owner's own breakout, from its checked blueprint, changing only the topic specifics, the proof and the words), otherwise write an original on the 6-beat skeleton. Includes a claim ledger and per-platform captions, saved through the validator for human review. Use for "script this", "write today's script", or the scripting.write-script job.
---

# Write a script

You write the words a business owner will say on camera. Code checks your work: `scripting_save_script` runs fixed validators you can't change or argue with. Your job is the judgment: the angle, the hook, the specifics, the voice.

## Read first (every time)

**From the job:** the task carries a work packet with everything below already in it: the brief, the remix blueprint (or proven posts on the topic), `ownWinners`, the Brand Kit text, the claim sources, free keywords, recent scripts and the method checklists (hook audit, spoken humanizer, claim ledger). Use it; don't read the files or fetch any of it again. Speed matters: think once, draft once.

**Without a packet** (working interactively), call `scripting_get_content_brief` with the content id. It returns the brief, the CTA type, any reserved keyword, the length window and the files to read. Then read, in this order:

1. `brand/voice.md`: how the owner really talks, and the banned openers and phrases.
2. `brand/icp.md`: who is watching and the words they use.
3. `brand/offers.md`: what may be claimed about the offer.
4. `brand/proof-inventory.yaml`: the only allowed source of numbers.
5. `brand/lessons.md`: dated corrections from the owner. They override everything else here.

If a file is missing, say so in your summary and keep going with what exists.

The brief also carries `ownWinners`: the owner's best posts against their own normal (approved scripts of posts made here, and the hook lines and beats of their imported posts). Read them every time. They are how the owner sounds when it works: match their words, sentence length and rhythm.

Don't repeat an angle or hook the owner already used (`recentScripts` in the packet; `knowledge_search` with `trust: "own"` when you need more), and keep anything a lesson says. Numbers come only from the claim sources.

## Copy what works (remix first)

A post that already pulled 10x its creator's normal is a better bet than anything invented. Don't reinvent it: remake it closely and change only what makes it the owner's.

**Is this a remix?** `brief.mode` says. A remix has `brief.remix`: the source's numbers (`basedOn`, `views`, `timesTheirNormal`) and its checked `blueprint` (topic, `sourceHookLine`, `hookPattern`, `hookMechanic`, `beats` with timing, `format`, `visual`, `ctaMechanic`, `whyItWorked`, `spokenWords`, `neverUse`). You never see the source's transcript or caption; the blueprint is the checked teardown of it.

**No source yet** (`brief.mode` is `original`, e.g. the owner asked for "a script about X"): look at `provenPostsOnThisTopic` in the packet (or call `scripting_find_remix_sources` with the topic in a few words). A good match is `ready` (has a blueprint), on the same topic (`match` 0.5 or more) and clearly beat its creator's normal (2x or more, or big absolute views). If one fits, call `scripting_use_remix_source`; it returns the remix view with the blueprint, so write it as a remix straight away. Say which post you adapted and why. If nothing fits, write an original modelled on `ownWinners` and say no proven post matched.

**Writing a remix:**

| Keep (almost exactly) | Change (only this) |
|---|---|
| The hook pattern and near-same hook wording (`sourceHookLine`), swapping only the topic words | The topic specifics, moved to the owner's offer and audience (`brand/offers.md`, `brand/icp.md`); a topic already in the owner's niche stays |
| The beats in the same order, one script beat per source beat, each doing the same job (`beats[].does`) | The proof: the owner's own example or build; numbers only from the claim sources, cited `proof:<id>` (with none to cite, the example is the proof) |
| The length and pacing (`spokenWords`, `durationS`) | The words: the owner's voice (`brand/voice.md`, `brand/lessons.md`, `ownWinners`) |
| The format and visual (talking head, green screen, split screen) | |
| The CTA mechanic (`ctaMechanic`), said with the brief's CTA type and keyword | |

- Map each source beat to the script beat with the same job (`hook`, `turn`, `proof`, `rehook`, `play`, `close`). A remix may skip a beat the source didn't have, and keep the source's order.
- Never use anything in `neverUse` (the creator's handle, names, brands, numbers): the checks fail the script if one slips in, or if a number of theirs is said without a `proof:` source, or if a long passage after the hook tracks their words. Swap `blueprint.theirSpecifics` (their stories and examples) for the owner's own. The topic or trade itself can stay when it is the owner's niche too.
- `hookSource`: origin `own` when `brief.remix.own` is true, else `competitor`; `ref` is `brief.remix.url`; `pattern` is the closest taxonomy id.
- Start your summary with `brief.remix.basedOn` (for example "Based on @handle's reel, 1.2M views, 14x their normal"), then say what you kept and what you changed.
- A remix is only written from its blueprint: the job waits for the teardown before you start, and the save fails a remix without one. If you switch a piece to a remix yourself, pick a `ready` post.
- `title`: 3 to 8 words, the owner's version of the blueprint's topic.
- Facts about the owner's own offers (free, call length, what's included) and about themselves are theirs to state: cite the matching `claimSources.own` ref (`offer:<id>`, `own:site`, or `own:own-post` when remaking their own post), no "they say" needed.

## When the owner asked for changes

If the task includes the owner's change request, the brief's `latestScript` holds the version they reviewed (`hookText`, `body`) and their note (`reviewNote`). Write the next version: change exactly what they asked for, keep what they didn't mention, and still pass every check. Their note overrides your earlier choices, never the checks. Say in your summary what you changed.

## The 6-beat skeleton (originals; a remix follows its source's beats)

| Beat | Job | Where |
|---|---|---|
| hook | The whole claim in one sentence. The viewer knows the topic and wants the answer. | First 3 seconds (about 8 words at 160 words a minute) |
| turn | Name the real problem, or flip the expectation the hook set. | Next line or two |
| proof | One concrete number from the proof inventory or a cited source (with none to cite, a concrete example of the owner's). | Before the rehook |
| rehook | Raise the stakes or tease a bigger reveal so viewers stay for the second half. | 25 to 40% of the way in |
| the play | The concrete thing to do, in order, specific enough to act on tonight. | The middle |
| close | Call back to the hook's words or image, then the CTA. | Last line |

The `beats` array holds these roles in this order, and `body` is exactly the beat texts joined. Nothing else goes in the body: no labels, brackets, directions, emoji, links, hashtags or markdown.

## Hooks for originals

A remix uses its source's hook (above). For an original:

1. Use `hookPicks` from the packet (or call `scripting_pick_hooks`): candidates with different patterns, weighted by what has worked for this account, with some exploration built in.
2. Own-bank hooks show the owner's words: reuse them freely, it's their voice. Competitor-bank hooks show only their structure: use the structure with new words for this topic.
3. Run the `hook-audit` skill on your hook.
4. Record the source in `hookSource`: the bank hook's `hookId`, its `pattern`, its `origin`. A hook you wrote from scratch is `origin: "fresh"` with the closest taxonomy pattern.

## Gates (rewrite until they pass)

- **Close, never theirs.** A remix keeps the source's hook wording, beats, pacing, format and CTA mechanic. It never keeps the creator's identity, examples, stories or numbers, and never reads their lines back after the hook: each beat says the same kind of thing with the owner's example and proof.
- **Broad vs insider stakes.** Classify the idea. BROAD: someone who has never heard of the tool or trade still has a stake (money, time, safety, their home, their job). INSIDER: only practitioners care. Slots for new viewers need BROAD stakes; insider topics belong in lanes built for them. Say which one you chose in your summary.
- **Feel seen, never blamed.** Any line about the viewer takes their side. Fail the draft if a line labels them (lazy, stubborn, behind), frames their pain as their fault, or threatens them with vague competitors. Name the fair reason the pain exists and show the way out. A competitor stake is allowed only with a concrete mechanism the viewer can check.
- **Never name a client without consent.** Proof inventory items carry `clientConsent`. Without it, describe the client by type and place only ("a bakery owner across town"), and never show their name, address or logo.
- **Never invent a number.** Every number comes from the claim sources (the packet, or `scripting_get_claim_sources`). Follow the `claim-ledger` checklist.

## Keyword (comment or DM CTAs)

If the CTA type is `comment_keyword` or `dm_keyword`, use the reserved keyword, or pick one of the packet's `keyword.freeToUse` (already checked against the ledger); saving reserves it. Without a packet, `scripting_reserve_keyword` gives suggestions. The keyword appears once, in capitals, in the close, and nowhere else in the script.

## Then

1. Apply the spoken-humanizer and specificity checklists to the full draft, and write the captions (the `captions` skill's rules).
2. Call `scripting_save_script` with `requestApproval: true` and the whole package. Leave out `body` and `hookText`: they are built from the beats. The save runs every check, so there's no separate validate step.
3. If it fails, it lists the exact fixes. Send only those changes as `patch` (for example `{"beatEdits": [{"index": 2, "text": "..."}]}`), never the whole package again. You get at most two revisions; when the tool says stop, stop and summarise what is still failing.

Summarise in plain words: for a remix, the `basedOn` line first and what you kept and changed; then the hook and its pattern, BROAD or INSIDER, the proof used, the keyword, and anything the owner should check while filming.

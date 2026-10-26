---
name: voice-profile
description: Build or refresh brand/voice.md from the owner's own on-camera transcripts, as counted evidence rather than adjectives, including the banned openers and phrases the validator reads. Use during onboarding, when new winning posts land, or when the owner says a script doesn't sound like them.
---

# Voice profile

`brand/voice.md` is evidence of how the owner really talks, built only from their own transcripts. Every line in it traces to a transcript. It is the file every script is written through, and the validator reads its banned lists.

## Build it

1. Collect 10 to 20 of the owner's own videos with transcripts (onboarding import or the own-account sync). Never use another creator's transcripts.
2. Rank them by performance against the owner's own median. Read the top third and the bottom third.
3. Count, don't guess: median sentence length, how often each recurring phrase appears, what line two usually does, how they say numbers, how they end.
4. Note what flopped and why. A pattern that fails for this owner is as useful as one that works.
5. Fill in the sections below, then ask the owner to approve the file. Write the date and the number of transcripts at the top.

## Sections

```markdown
# Voice profile
Built from <n> transcripts on <date>.

## Who it's for
One paragraph from brand/icp.md plus what the transcripts show about which framings won.

## The shape of a winner
The beat order of the best posts, with the owner's usual wording for each beat.

## Openers that work
One bullet per hook pattern that has won, with the pattern id from the taxonomy.

## Words and rhythm
Sentence length, contractions, filler words to KEEP, how numbers are said.

## How they talk about their work
Trade words they use, words they never use, how they describe clients.

## Banned openers
- "<opener>"

## Never say
- "<phrase>"
```

## Banned lists (the validator reads these)

- Put openers under a heading containing "Banned openers" (or "Never open with").
- Put phrases under a heading containing "Never say" (or "Banned words", "Avoid").
- One entry per bullet. Quote the exact words: `- "phrase here"`. Unquoted bullets are cut at the first colon or parenthesis; slashes and commas split alternatives.

Brand-wide bans that also apply to captions and posts can go in `brand/brand.yaml` under `bannedPhrases`.

## Refresh

When new winners land, re-rank, add their openers to the own bank (the harvest job does this automatically), and retire patterns that stopped working. When the owner corrects a script, add the correction to `brand/lessons.md` the same day.

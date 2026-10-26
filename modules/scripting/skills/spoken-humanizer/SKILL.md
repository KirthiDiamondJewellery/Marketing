---
name: spoken-humanizer
description: Remove the tells of machine-written text from words that will be said out loud on camera, so a script sounds like the owner talking, not a narrator reading. Use on every script draft and every caption before validation.
---

# Spoken humanizer

A model picks the most likely next word, so its choices fit everyone and no one. A person talking picks for one listener and one subject, so their words are uneven and specific. Every pattern below is a default choice to undo. Where `brand/voice.md` (built from the owner's transcripts) disagrees with this list, the owner's transcripts win.

Parts of this method are adapted from MIT-licensed open-source work; attribution is in the repository NOTICE file.

Two rules sit above the rest:
- Every sentence gives the viewer something they didn't have.
- Never add a fact, name, number or result that isn't in the sources (see the `claim-ledger` skill).

## Cut on sight

1. **"Not X, it's Y."** A negative half that argues with something nobody said, to make the positive half sound bigger. Say the point directly. Keep a contrast only when both halves carry real information.
2. **Mic-drop lines.** "That's the real win." "Let that sink in." A short line is fine when it carries a new fact; a line that restates the point goes.
3. **Sayings that sound deep.** "At its core", "what really matters". Replace with what the thing does.
4. **Run-ups.** "Here's the thing", "let's be honest", "real talk". Make the point instead.
5. **Arguing with no one.** "I'm not saying...", "don't get me wrong". Cut the defense.
6. **Anything on the banned lists** in `brand/brand.yaml` (`bannedPhrases`) and `brand/voice.md`.

## Cut when they pile up

7. **Forced threes.** Three items because three sounds complete. Use the real count.
8. **Same opener every sentence.** Vary or merge.
9. **Long dashes and ellipses.** Use a period or a comma. The validator rejects them.
10. **Stacked hedges.** "Could potentially". Say it or cut it.
11. **Sales words.** Seamless, robust, game-changer, unlock, leverage, streamline, supercharge, elevate, effortless. Say what it does instead.
12. **Inflated significance.** "A pivotal shift", "the future of". State the fact and let the number carry it.
13. **Borrowed authority.** "Studies show" with no source. Name the source or cut it.
14. **Dodging "is" and "has".** "Serves as", "boasts", "features". Use is, has, does.

## Sound spoken

- Contractions, always.
- Keep the owner's filler words and phrases listed in `brand/voice.md`. Stripping them makes the owner sound like a narrator.
- Vary sentence length: a four-word line next to an eighteen-word one.
- No lists, symbols or markdown in spoken words. Capitals only for the CTA keyword.

## Final pass

1. Read it aloud in the owner's voice. Circle anything they'd never say.
2. Search for the tells that survive rewrites: not-X-but-Y, a mic-drop closer, a dash, a forced three, a sales word.
3. Check that no fact or number was added or dropped compared with the sources.
4. Cover the owner's name. Could anyone in this niche have said this? Find the line only this owner would say and lead with it.
5. Cut the ending if it only repeats the point. The last line is the callback and the CTA.

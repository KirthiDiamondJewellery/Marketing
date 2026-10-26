import { describe, expect, it } from "vitest";
import { findPhrase, mergeBanned, parseBannedFromVoiceMd, phraseRegex } from "../src/index.ts";

const VOICE = `# Voice profile

Built from 14 transcripts.

## Words and rhythm
- Short sentences.
- "honestly" shows up a lot, keep it.

## Banned openers
- "So, here's the deal"
- Picture this: a slow start
- **Quick question**

## Never say
- "dream home"
- synergy / circle back
- "luxury", "bespoke"
- game changer (sounds like an ad)

### Notes
- not a phrase, just a sub-note

## Openers that work
- The claim, first line.

\`\`\`
## Never say
- inside a code fence
\`\`\`
`;

describe("parseBannedFromVoiceMd", () => {
  const parsed = parseBannedFromVoiceMd(VOICE);
  it("reads openers", () => {
    expect(parsed.openers).toEqual(["So, here's the deal", "Picture this", "Quick question"]);
  });
  it("reads phrases, splitting alternatives and quoted lists", () => {
    expect(parsed.phrases).toEqual(["dream home", "synergy", "circle back", "luxury", "bespoke", "game changer", "not a phrase", "just a sub-note"]);
  });
  it("ignores sections that aren't banned lists and fenced code", () => {
    expect(parsed.phrases).not.toContain("honestly");
    expect(parsed.phrases).not.toContain("inside a code fence");
    expect(parsed.openers).not.toContain("The claim, first line");
  });
  it("handles curly quotes and an empty file", () => {
    expect(parseBannedFromVoiceMd("## Banned words\n- “dream home”\n").phrases).toEqual(["dream home"]);
    expect(parseBannedFromVoiceMd("")).toEqual({ openers: [], phrases: [] });
  });
  it("merges lists without duplicates", () => {
    expect(mergeBanned({ phrases: ["Dream home"] }, { phrases: ["dream home", "synergy"], openers: ["so"] })).toEqual({ phrases: ["Dream home", "synergy"], openers: ["so"] });
  });
});

describe("phrase matching", () => {
  it.each([
    ["dream home", "Build your dream home today", true],
    ["dream home", "Build your dreamhome today", false],
    ["dream home", "Build your dream   home", true],
    ["let's talk about", "Let’s talk about permits", true],
    ["game-changer", "a real game-changer", true],
    ["art", "a smart start", false],
  ])("%s in %s → %s", (phrase, text, expected) => {
    expect(phraseRegex(phrase).test(text)).toBe(expected);
  });
  it("anchored matching only hits the start", () => {
    expect(findPhrase("Here are three fixes", ["here are"], { anchored: true })).not.toBeNull();
    expect(findPhrase("Fixes here are three", ["here are"], { anchored: true })).toBeNull();
    expect(findPhrase('"Here are three fixes"', ["here are"], { anchored: true })).not.toBeNull();
  });
});

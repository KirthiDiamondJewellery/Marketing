import { describe, expect, it } from "vitest";
import { clearWinner, contentTokens, hookScore, rankScripts, scoreScript, words, type ScriptCandidate } from "../src/match.ts";

const SCRIPTS: ScriptCandidate[] = [
  {
    contentId: "a",
    title: "Most notebooks break at the spine",
    hook: "Most notebooks don't break at the cover.",
    body: "Most notebooks don't break at the cover.\nThey break at the spine, where the thread is pulled too tight.\nWe test every binding by opening it flat two hundred times.\nComment STITCH for the checklist we use.",
  },
  {
    contentId: "b",
    title: "Three papers we stopped buying",
    hook: "We stopped buying three kinds of paper this year.",
    body: "We stopped buying three kinds of paper this year.\nThe first one bled through with every fountain pen.\nThe second curled in humid weather.\nThe third yellowed in six months. Here is what we use instead.",
  },
  {
    contentId: "c",
    title: "How long a workshop takes",
    hook: "A bookbinding workshop takes four hours, not two.",
    body: "A bookbinding workshop takes four hours, not two.\nHalf of that is waiting for glue to set.\nWe use that time to teach the stitch.\nBook a seat from the link in bio.",
  },
];

describe("words and tokens", () => {
  it("normalises punctuation, case and spelled-out numbers", () => {
    expect(words("Don't break — at the COVER, 4.1% of the time!")).toEqual(["dont", "break", "at", "the", "cover", "4.1", "percent", "of", "the", "time"]);
    expect(words("four hours")).toEqual(["4", "hours"]);
    expect(contentTokens("The notebooks are breaking")).toEqual(["notebook", "break"]);
  });
});

describe("matching a take to its script", () => {
  it("ranks the right script first from a noisy transcript of the first minute", () => {
    const said = "um most notebooks don't break at the cover most notebooks don't break at the cover they break at the spine where the thread is pulled too tight we test every binding";
    const ranked = rankScripts(said, SCRIPTS);
    expect(ranked[0]!.contentId).toBe("a");
    expect(ranked[0]!.score).toBeGreaterThan(0.62);
    expect(ranked[0]!.hookScore).toBe(1);
    expect(ranked[0]!.score - ranked[1]!.score).toBeGreaterThan(0.3);
    expect(clearWinner(ranked, { above: 0.62, margin: 0.12 })?.contentId).toBe("a");
  });

  it("matches on the hook even when only the opening was filmed", () => {
    const ranked = rankScripts("a book binding workshop takes 4 hours not two", SCRIPTS);
    expect(ranked[0]!.contentId).toBe("c");
    expect(ranked[0]!.hookScore).toBeGreaterThan(0.8);
  });

  it("doesn't link on its own when nothing matches clearly", () => {
    const ranked = rankScripts("today we are talking about the weather and what to cook for dinner tonight", SCRIPTS);
    expect(ranked[0]!.score).toBeLessThan(0.4);
    expect(clearWinner(ranked, { above: 0.62, margin: 0.12 })).toBeNull();
  });

  it("gives no score to a take with almost no speech", () => {
    expect(scoreScript("okay", SCRIPTS[0]!).score).toBe(0);
  });

  it("needs a margin over the runner-up", () => {
    const twins = [SCRIPTS[0]!, { ...SCRIPTS[0]!, contentId: "a2", title: "Same script, second version" }];
    const ranked = rankScripts("most notebooks don't break at the cover they break at the spine", twins);
    expect(ranked[0]!.score).toBeGreaterThan(0.62);
    expect(clearWinner(ranked, { above: 0.62, margin: 0.12 })).toBeNull();
  });

  it("finds the hook anywhere near the start (several attempts at the opening)", () => {
    const said = "okay wait let me start again we stopped uh we stopped buying three kinds of paper this year the first one bled through";
    expect(hookScore(contentTokens(said), SCRIPTS[1]!.hook)).toBe(1);
  });
});

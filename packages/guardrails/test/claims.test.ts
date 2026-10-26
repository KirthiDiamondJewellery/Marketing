import { describe, expect, it } from "vitest";
import { extractNumbers, findFakeStats, isHedged, parseNumber, validateClaimLedger } from "../src/index.ts";
import { codes, SOURCES, warnCodes } from "./fixtures.ts";

describe("extractNumbers", () => {
  it.each([
    ["We tracked 42 projects", [42]],
    ["It cost $5k to fix", [5000]],
    ["1,200 leads in 3.5 months", [1200, 3.5]],
    ["up 40% this year", [40]],
    ["up 40 percent", [40]],
    ["3 million views", [3_000_000]],
    ["forty projects", [40]],
    ["twenty-five homes", [25]],
    ["two hundred and fifty calls", [250]],
    ["three thousand dollars", [3000]],
    ["two ways to fix it", []],
    ["three times more leads", [3]],
    ["five clients said yes", [5]],
    ["one thing matters", []],
    ["v2 of the tool", []],
  ] as const)("%s → %j", (text, values) => {
    expect(extractNumbers(text).map((n) => n.value)).toEqual(values);
  });

  it("counts small number words in all mode", () => {
    expect(extractNumbers("two ways", { all: true }).map((n) => n.value)).toEqual([2]);
    expect(extractNumbers("one thing", { all: true })).toEqual([]);
  });

  it("parses stated values", () => {
    expect(parseNumber("18%")).toBe(18);
    expect(parseNumber("$1.2m")).toBe(1_200_000);
    expect(parseNumber("forty")).toBe(40);
    expect(parseNumber("n/a")).toBeNull();
    expect(parseNumber(7)).toBe(7);
  });
});

describe("known fake stats", () => {
  it.each([
    ["We only use 10% of our brain", "ten-percent-brain"],
    ["Your attention span is shorter than a goldfish", "goldfish-attention"],
    ["the average attention span is 8 seconds", "eight-second-attention"],
    ["93% of communication is nonverbal", "mehrabian-93"],
    ["It takes 21 days to build a habit", "habit-21-days"],
    ["People need to see an ad seven times before they buy", "rule-of-seven"],
  ])("%s", (text, id) => {
    expect(findFakeStats(text).map((f) => f.id)).toContain(id);
  });
  it("leaves real claims alone", () => {
    expect(findFakeStats("We tracked 42 projects last year")).toEqual([]);
  });
});

describe("isHedged", () => {
  it.each([
    ["They say remodel costs rose 27%", true],
    ["According to the report, costs rose 27%", true],
    ["The survey found that costs rose 27%", true],
    ["Costs rose 27%", false],
  ])("%s → %s", (text, expected) => expect(isHedged(text)).toBe(expected));
});

describe("validateClaimLedger", () => {
  const cases: [string, unknown[], string[], string[]][] = [
    ["proof claim with recorded numbers", [{ claim: "We tracked 42 projects", verdict: "PASS", source: "proof:project-tracker" }], [], []],
    ["bare proof id", [{ claim: "We tracked 42 projects", verdict: "PASS", source: "project-tracker" }], [], []],
    ["CUT needs no source", [{ claim: "Remodels always run over", verdict: "CUT" }], [], []],
    ["PASS without source", [{ claim: "We tracked 42 projects", verdict: "PASS" }], ["claims.no_source"], []],
    ["unknown source", [{ claim: "We tracked 42 projects", verdict: "PASS", source: "proof:nope" }], ["claims.unknown_source"], []],
    ["number not in proof item", [{ claim: "We tracked 45 projects", verdict: "PASS", source: "proof:project-tracker" }], ["claims.number_not_in_proof"], []],
    ["single source needs hedge", [{ claim: "Remodel costs rose 27% this year", verdict: "PASS", source: "cited:trend-1" }], ["claims.needs_hedge"], []],
    ["hedged single source passes", [{ claim: "The report says remodel costs rose 27% this year", verdict: "PASS", source: "cited:trend-1" }], [], []],
    ["cited number not stated by source", [{ claim: "The report says costs rose 30%", verdict: "PASS", source: "cited:trend-1" }], ["claims.number_not_in_source"], []],
    ["corroborated needs no hedge", [{ claim: "Lumber prices are volatile", verdict: "PASS", source: "cited:trend-2" }], [], []],
    ["bare url is single-source", [{ claim: "Permits take longer in spring", verdict: "PASS", source: "https://example.com/permits" }], ["claims.needs_hedge"], []],
    ["bare url number is unverifiable", [{ claim: "The city says permits take 6 weeks", verdict: "PASS", source: "https://example.com/permits" }], [], ["claims.number_unverifiable"]],
    ["fake stat even with PASS", [{ claim: "We only use 10% of our brain", verdict: "PASS", source: "https://example.com/x" }], ["claims.fake_stat", "claims.needs_hedge"], ["claims.number_unverifiable"]],
    ["FIX without note warns", [{ claim: "We tracked 42 projects", verdict: "FIX", source: "proof:project-tracker" }], [], ["claims.fix_without_note"]],
    ["bad verdict", [{ claim: "x", verdict: "MAYBE" }], ["claims.shape"], []],
    ["duplicate ids", [{ id: "a", claim: "We tracked 42 projects", verdict: "PASS", source: "proof:project-tracker" }, { id: "a", claim: "Remodels run long", verdict: "CUT" }], ["claims.duplicate_id"], []],
  ];
  it.each(cases)("%s", (_name, claims, errs, warns) => {
    const r = validateClaimLedger(claims, SOURCES);
    expect(codes(r)).toEqual(errs);
    expect(warnCodes(r)).toEqual(warns);
  });

  it("treats the owner's own offers and site as theirs to state (no hedge), cited as offer:<id> or a link on their site", () => {
    const own = { ...SOURCES, own: [
      { id: "starter-plan", title: "Starter plan", url: "https://examplebrand.example/plans", wholeSite: true },
      { id: "own-post", title: "Your own post", url: "https://www.instagram.com/reel/own1/" },
    ] };
    const r = validateClaimLedger([
      { id: "c1", claim: "The first planning call is free", verdict: "PASS", source: "offer:starter-plan" },
      { id: "c2", claim: "The plan covers every room", verdict: "PASS", source: "https://www.examplebrand.example/about" },
      { id: "c3", claim: "The call runs 30 minutes", verdict: "PASS", source: "cited:starter-plan" },
    ], own);
    expect(codes(r)).toEqual([]);
    expect(warnCodes(r)).toEqual(["claims.number_unverifiable"]);
    // Someone else's site is still an outside source, and so is any other post on the platform the owner's post is on.
    expect(codes(validateClaimLedger([{ claim: "Plans cover every room", verdict: "PASS", source: "https://other.example/x" }], own))).toEqual(["claims.needs_hedge"]);
    expect(codes(validateClaimLedger([{ claim: "I plan every room myself", verdict: "PASS", source: "https://www.instagram.com/reel/own1" }], own))).toEqual([]);
    expect(codes(validateClaimLedger([{ claim: "I plan every room myself", verdict: "PASS", source: "own:own-post" }], own))).toEqual([]);
    expect(codes(validateClaimLedger([{ claim: "They plan every room", verdict: "PASS", source: "https://www.instagram.com/reel/other9/" }], own))).toEqual(["claims.needs_hedge"]);
    expect(codes(validateClaimLedger([{ claim: "x", verdict: "PASS", source: "offer:nope" }], own))).toEqual(["claims.unknown_source"]);
  });

  it("warns on a spent stat", () => {
    const r = validateClaimLedger([{ claim: "We tracked 42 projects", verdict: "PASS", source: "proof:project-tracker" }], {
      ...SOURCES,
      recentStats: [{ value: "42", usedAt: "2026-10-01T10:00:00Z", scriptRef: "Why remodel budgets break, v1" }],
    });
    expect(r.ok).toBe(true);
    expect(warnCodes(r)).toEqual(["claims.spent_stat"]);
    expect(r.warnings[0]!.message).toContain("2026-10-01");
  });
});

describe("more fake stats", () => {
  it.each([
    ["Only 3% of people have written goals", "written-goals-study"],
    ["90 percent of small businesses fail", "small-business-failure"],
  ])("%s", (text, id) => expect(findFakeStats(text).map((f) => f.id)).toContain(id));
});

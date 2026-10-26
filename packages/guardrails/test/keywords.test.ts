import { describe, expect, it } from "vitest";
import { checkKeyword, suggestKeywords } from "../src/index.ts";
import { codes } from "./fixtures.ts";

describe("checkKeyword", () => {
  const ledger = ["guide", "estimate", "Kitchen"];

  it.each([
    ["blueprint", [], "", []],
    ["BLUEPRINT", ledger, "Comment BLUEPRINT and I'll send it.", []],
    ["", ledger, "", ["keyword.missing"]],
    ["abc", ledger, "", ["keyword.format"]],
    ["abcdefghij", ledger, "", ["keyword.format"]],
    ["two words", ledger, "", ["keyword.format"]],
    ["plan2", ledger, "", ["keyword.format"]],
    ["café", ledger, "", ["keyword.format"]],
    ["guide", ledger, "", ["keyword.reused"]],
    ["GUIDE", ledger, "", ["keyword.reused"]],
    ["kitchen", ledger, "", ["keyword.reused"]],
    ["guides", ledger, "", ["keyword.collision"]],
    ["estim", ledger, "", ["keyword.collision"]],
    ["kitchens", ledger, "", ["keyword.collision"]],
    ["this", [], "", ["keyword.too_common"]],
    ["thanks", [], "", ["keyword.too_common"]],
    ["scope", [], "Get a fixed scope for every room.", ["keyword.in_script"]],
    ["scope", [], "Get a fixed Scope for every room.", ["keyword.in_script"]],
    ["scope", [], "Telescope views. Comment SCOPE.", ["keyword.inside_word"]],
    ["plan", [], "Planning matters. Comment PLAN.", ["keyword.inside_word"]],
  ] as const)("%s with ledger %j and script %j → %j", (word, led, script, expected) => {
    const r = checkKeyword(word, led, script);
    expect(codes(r)).toEqual(expected);
    expect(r.ok).toBe(expected.length === 0);
  });

  it("explains a collision with both words", () => {
    const r = checkKeyword("guides", ["guide"]);
    expect(r.errors[0]!.message).toContain('"guides"');
    expect(r.errors[0]!.message).toContain('"guide"');
    expect(r.errors[0]!.fix).toBeTruthy();
  });

  it("reports each offending script word once", () => {
    const r = checkKeyword("plan", [], "planning, planning and more planning");
    expect(r.errors).toHaveLength(1);
  });
});

describe("suggestKeywords", () => {
  it("returns valid, non-colliding words, candidates first", () => {
    const out = suggestKeywords({
      topicText: "Why remodel budgets break before demolition, budget checklist",
      ledgerWords: ["guide"],
      scriptText: "Your remodel budget breaks.",
      candidates: ["ledger", "guides", "x"],
    });
    expect(out[0]).toBe("ledger");
    expect(out).not.toContain("guides");
    expect(out).not.toContain("remodel");
    for (const w of out) expect(checkKeyword(w, ["guide"], "Your remodel budget breaks.").ok).toBe(true);
    for (const a of out) for (const b of out) if (a !== b) expect(a.includes(b)).toBe(false);
  });

  it("respects count", () => {
    expect(suggestKeywords({ topicText: "framing drywall plumbing roofing siding windows", ledgerWords: [], count: 2 })).toHaveLength(2);
  });
});

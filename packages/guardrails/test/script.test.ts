import { describe, expect, it } from "vitest";
import { checkBanned, checkPunctuation, checkSpokenOnly, validateScript, type ScriptPackageInput } from "../src/index.ts";
import { CLOSE, codes, PLAY, rules, validPackage, warnCodes, withBeat } from "./fixtures.ts";

describe("validateScript: the valid fixture", () => {
  it("passes with no errors", () => {
    const r = validateScript(validPackage(), rules());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("shape", () => {
  it.each([
    ["missing body", (p: ScriptPackageInput) => ({ ...p, body: undefined })],
    ["bad beat role", (p: ScriptPackageInput) => ({ ...p, beats: [{ role: "intro", text: "x" }] })],
    ["missing hookSource", (p: ScriptPackageInput) => ({ ...p, hookSource: undefined })],
    ["unknown cta type", (p: ScriptPackageInput) => ({ ...p, cta: { type: "subscribe" } })],
  ])("%s → script.shape", (_n, mutate) => {
    const r = validateScript(mutate(validPackage()) as unknown, rules());
    expect(r.ok).toBe(false);
    expect(new Set(codes(r))).toEqual(new Set(["script.shape"]));
  });
});

describe("spoken words only", () => {
  it.each([
    ["Here's the fix [B-ROLL: kitchen].", "spoken.brackets"],
    ["Here's the fix (point at the screen).", "spoken.parenthetical"],
    ["## The fix", "spoken.markdown_heading"],
    ["- first fix", "spoken.list_marker"],
    ["1. first fix", "spoken.list_marker"],
    ["> quoted", "spoken.quote_block"],
    ["Hook: your budget breaks.", "spoken.label"],
    ["CTA: comment below.", "spoken.label"],
    ["On screen: the invoice.", "spoken.label"],
    ["This is **huge**.", "spoken.markdown"],
    ["Budgets break \u{1F525}", "spoken.emoji"],
    ["Go to https://example.com now", "spoken.url"],
    ["Use #designbuild", "spoken.hashtag"],
    ["Ask @examplebrand", "spoken.handle"],
    ["Scope & price", "spoken.symbol"],
    ["Scope + price", "spoken.symbol"],
    ["| a | b |", "spoken.table"],
    ["Fill in {client name} here", "spoken.brackets"],
  ])("%s → %s", (text, code) => {
    expect(codes(checkSpokenOnly(text))).toContain(code);
  });
  it("accepts plain speech with $ and %", () => {
    expect(checkSpokenOnly("It cost $5,000 and saved 18% on the job. Don't skip it.").ok).toBe(true);
  });
});

describe("punctuation and caps", () => {
  it.each([
    ["Budgets break \u2014 early.", {}, "punctuation.dash"],
    ["Budgets break \u2013 early.", {}, "punctuation.dash"],
    ["Budgets break - early.", {}, "punctuation.dash"],
    ["Budgets break...", {}, "punctuation.ellipsis"],
    ["Budgets break\u2026", {}, "punctuation.ellipsis"],
    ["Really?!", {}, "punctuation.repeated"],
    ["This is HUGE.", {}, "caps.shouting"],
  ] as const)("%s → %s", (text, extra, code) => {
    expect(codes(checkPunctuation(text, extra))).toContain(code);
  });
  it.each([
    ["Budgets break \u2014 early.", { allowDashes: true }],
    ["Budgets break...", { allowEllipsis: true }],
    ["Ask your HVAC tech.", { allowedCaps: ["HVAC"] }],
    ["Ask about ROI and AI.", {}],
    ["Comment BLUEPRINT now.", { keyword: "blueprint" }],
    ["A well-built plan.", {}],
  ] as const)("%s passes with %j", (text, extra) => {
    expect(checkPunctuation(text, extra).errors).toEqual([]);
  });
  it("warns on several exclamation marks and semicolons", () => {
    const r = checkPunctuation("Wow! Big! Done; next.", {});
    expect(warnCodes(r)).toEqual(["punctuation.exclamations", "punctuation.semicolon"]);
  });
});

describe("banned openers and phrases", () => {
  it.each([
    ["Let me explain why budgets break.", {}, "script.banned_opener"],
    ["Hey guys, budgets break.", {}, "script.banned_opener"],
    ["Here are 5 tips for budgets.", {}, "script.banned_opener"],
    ["So here's the deal, budgets break.", { openers: ["so here's the deal"] }, "script.banned_opener"],
    ["Comment PLAN for my checklist.", {}, "script.cta_opener"],
    ["Your dream home costs more.", { phrases: ["dream home"] }, "script.banned_phrase"],
  ] as const)("%s → %s", (text, lists, code) => {
    expect(codes(checkBanned(text, lists))).toContain(code);
  });
  it("can turn off the default openers", () => {
    expect(checkBanned("Here are the numbers.", { useDefaultOpeners: false }).ok).toBe(true);
  });
  it.each([
    ["This is a game changer for kitchens.", "script.sales_word"],
    ["Here's the thing, budgets break.", "script.run_up"],
    ["It's not about the cabinets, it's the plan.", "script.not_x_but_y"],
  ])("%s warns %s", (text, code) => {
    expect(warnCodes(checkBanned(text, {}))).toContain(code);
  });
});

describe("validateScript rules", () => {
  const run = (pkg: ScriptPackageInput, over = {}) => validateScript(pkg, rules(over));

  it("length window: too long and too short", () => {
    expect(codes(run(validPackage(), { maxSeconds: 30 }))).toContain("length.too_long");
    const short = run(validPackage(), { minSeconds: 70, maxSeconds: 90 });
    expect(codes(short)).toContain("length.too_short");
    expect(short.errors.find((e) => e.code === "length.too_short")!.fix).toMatch(/Add about \d+ words/);
  });

  it("wpm changes the length", () => {
    expect(run(validPackage(), { wpm: 100 }).ok).toBe(false);
  });

  it("missing beats are named", () => {
    const pkg = validPackage();
    const beats = pkg.beats.filter((b) => b.role !== "rehook" && b.role !== "turn");
    const r = run({ ...pkg, beats, body: beats.map((b) => b.text).join(" ") });
    expect(r.errors.filter((e) => e.code === "beats.missing").map((e) => e.message)).toEqual(["The script has no turn beat.", "The script has no rehook beat."]);
  });

  it("beats out of order", () => {
    const pkg = validPackage();
    const beats = [pkg.beats[0]!, pkg.beats[2]!, pkg.beats[1]!, ...pkg.beats.slice(3)];
    expect(codes(run({ ...pkg, beats, body: beats.map((b) => b.text).join(" ") }))).toContain("beats.order");
  });

  it("body must match beats", () => {
    expect(codes(run({ ...validPackage(), body: validPackage().body + " Extra words." }))).toContain("beats.body_mismatch");
  });

  it("proof needs a number", () => {
    const r = run(withBeat("proof", "Last year the projects with a fixed scope finished under the first quote, almost every time."));
    expect(codes(r)).toContain("beats.proof_without_number");
  });

  it("proof without a number only warns when there is no number to cite, and can be switched off", () => {
    const pkg = withBeat("proof", "Last year the projects with a fixed scope finished under the first quote, almost every time.");
    const warn = run(pkg, { proofNumber: "warn" });
    expect(codes(warn)).not.toContain("beats.proof_without_number");
    expect(warnCodes(warn)).toContain("beats.proof_without_number");
    const off = run(pkg, { proofNumber: "off" });
    expect([...codes(off), ...warnCodes(off)]).not.toContain("beats.proof_without_number");
  });

  it("slow hook is an error, slightly slow a warning", () => {
    const slow = run(withBeat("hook", "Your remodel budget breaks long before the crew ever shows up to start the demolition work on the house."));
    expect(codes(slow)).toContain("hook.too_slow");
    const bit = run(withBeat("hook", "Your remodel budget quietly breaks before demolition even starts."));
    expect(warnCodes(bit)).toContain("hook.slow");
    expect(codes(bit)).not.toContain("hook.too_slow");
  });

  it("rehook position outside the window", () => {
    const pkg = validPackage();
    const beats = [pkg.beats[0]!, pkg.beats[3]!, pkg.beats[1]!, pkg.beats[2]!, pkg.beats[4]!, pkg.beats[5]!];
    const r = run({ ...pkg, beats, body: beats.map((b) => b.text).join(" ") });
    expect(codes(r)).toContain("beats.rehook_position");
  });

  it("close without a callback warns", () => {
    const r = run(withBeat("close", "That's the whole list. Comment BLUEPRINT and I'll send you the checklist."));
    expect(warnCodes(r)).toContain("beats.no_callback");
  });

  it("hookText must match the hook beat", () => {
    expect(codes(run({ ...validPackage(), hookText: "Something else entirely." }))).toContain("hook.text_mismatch");
  });

  it("CTA in the hook", () => {
    expect(codes(run(withBeat("hook", "Comment BLUEPRINT if your remodel budget broke.")))).toContain("hook.cta_in_hook");
  });

  describe("CTA matches the CTA type", () => {
    it.each([
      ["comment_keyword", "blueprint", CLOSE, []],
      ["comment_keyword", "blueprint", "Get those three in writing and your budget holds past demolition. Comment blueprint for the checklist.", ["cta.keyword_case"]],
      ["comment_keyword", "blueprint", "Get those three in writing and your budget holds past demolition. Comment below for the checklist.", ["cta.keyword_not_said"]],
      ["comment_keyword", null, CLOSE, ["cta.keyword_missing"]],
      ["dm_keyword", "blueprint", "Get those three in writing and your budget holds past demolition. DM me BLUEPRINT for the checklist.", []],
      ["dm_keyword", "blueprint", CLOSE, ["cta.mismatch"]],
      ["link_in_bio", null, "Get those three in writing and your budget holds past demolition. The checklist is at the link in my bio.", []],
      ["link_in_bio", null, CLOSE, ["cta.mismatch"]],
      ["book_call", null, "Get those three in writing and your budget holds past demolition. Book a call at the link in my bio.", []],
      ["book_call", null, CLOSE, ["cta.mismatch"]],
      ["follow", null, "Get those three in writing and your budget holds past demolition. Follow for the next one on permits.", []],
      ["save_share", null, "Get those three in writing and your budget holds past demolition. Save this before your first meeting.", []],
      ["none", null, "Get those three in writing and your budget holds past demolition.", []],
    ] as const)("%s / %s", (type, keyword, close, expected) => {
      const pkg = { ...withBeat("close", close), cta: { type, keyword } };
      const r = validateScript(pkg, rules({ requireCaptions: false }));
      expect(codes(r).filter((c) => c.startsWith("cta.") && !c.startsWith("cta.keyword."))).toEqual(expected);
    });

    it("none with an ask warns", () => {
      const r = validateScript({ ...validPackage(), cta: { type: "none" }, captions: undefined }, rules({ requireCaptions: false }));
      expect(warnCodes(r)).toContain("cta.unexpected");
    });

    it("brand CTA line must be said as written", () => {
      const r = run(validPackage(), { ctaLines: { comment_keyword: "Comment {word} and I'll send you the guide." } });
      expect(codes(r)).toContain("cta.line_mismatch");
      const ok = run(validPackage(), { ctaLines: { comment_keyword: "Comment {word} and I'll send you the checklist" } });
      expect(codes(ok)).not.toContain("cta.line_mismatch");
    });
  });

  it("hook_source must say which bank entry", () => {
    const r = run({ ...validPackage(), hookSource: { pattern: "cost-of-mistake", origin: "competitor" } });
    expect(codes(r)).toContain("hook_source.missing_ref");
    const fresh = run({ ...validPackage(), hookSource: { pattern: "cost-of-mistake", origin: "fresh" } });
    expect(codes(fresh)).not.toContain("hook_source.missing_ref");
    expect(warnCodes(run(validPackage(), { knownPatterns: ["contrarian"] }))).toContain("hook_source.unknown_pattern");
  });

  it("keyword must be valid and unused", () => {
    expect(codes(run(validPackage(), { keywordLedger: ["blueprint"] }))).toContain("keyword.reused");
    const inScript = run(withBeat("play", PLAY.replace("keep looking", "ask for the blueprint")));
    expect(codes(inScript)).toContain("keyword.in_script");
  });

  it("every number needs a PASS claim", () => {
    const r = run(withBeat("play", PLAY.replace("over coffee", "in 5 minutes")));
    const err = r.errors.find((e) => e.code === "claims.unlisted_number");
    expect(err?.message).toContain('"5"');
    expect(err?.path).toBe("body");
  });

  it("a CUT number still in the script is an error", () => {
    const pkg = withBeat("play", PLAY.replace("over coffee", "in 5 minutes"));
    pkg.claimLedger = [...(pkg.claimLedger ?? []), { claim: "Updates take 5 minutes to read", verdict: "CUT" }];
    expect(codes(run(pkg))).toContain("claims.cut_in_script");
  });

  it("ledger problems surface in the script report", () => {
    const pkg = validPackage();
    pkg.claimLedger = [{ claim: "We tracked 42 projects last year", verdict: "PASS", source: "proof:missing" }, pkg.claimLedger![1]!];
    expect(codes(run(pkg))).toEqual(["claims.unknown_source"]);
  });

  it("fake stats in the script", () => {
    const r = run(withBeat("turn", "Your attention span is shorter than a goldfish, so the plan gets skimmed. The real leak is the plan you signed off on in week one."));
    expect(codes(r)).toContain("script.fake_stat");
  });

  it("banned phrase from the brand", () => {
    expect(codes(run(withBeat("turn", "Your dream home gets the blame. The real leak is the plan you signed off on in week one.")))).toContain("script.banned_phrase");
  });

  it("captions are validated and required", () => {
    const pkg = validPackage();
    const caps = pkg.captions as Record<string, { hashtags: string[] }>;
    caps.instagram!.hashtags = ["#fyp", "#designbuild", "#kitchenremodel"];
    const r = run(pkg);
    expect(r.errors.find((e) => e.code === "hashtags.generic")?.path).toBe("captions.instagram.hashtags[0]");
    expect(codes(run({ ...validPackage(), captions: undefined }))).toContain("captions.missing");
  });
});

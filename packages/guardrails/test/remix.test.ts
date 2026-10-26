import { describe, expect, it } from "vitest";
import { checkRemix, longestSharedRun, validateScript, type RemixRules, type ScriptPackageInput, type ScriptRules } from "../src/index.ts";
import { SOURCES, validCaptions } from "./fixtures.ts";

/**
 * A close remix of a (fictional) outlier: same hook wording with the topic words swapped, the same four beats in the
 * same order, the same comment-a-keyword ending. The source is a demo creator's transcript; the script is the
 * fictional demo brand's.
 */
const SOURCE_HOOK = "The cheapest cabinet quote we got was missing three things.";
const SOURCE_TEXT =
  `${SOURCE_HOOK} First, the install labour was never in the price. Second, the crown moulding was an extra 900 dollars. ` +
  "Third, nobody had priced hauling the old boxes away. I am Rowan from Maple and Oak and we fixed it for 14000 dollars. " +
  "Comment QUOTE and I will send you the checklist we use for every single cabinet quote we look at.";

const HOOK = "The cheapest remodel quote you get is missing three things.";
const PROOF = "Last year we tracked 42 projects, and the fixed-scope ones finished 18 percent under the first quote.";
const PLAY = "First, the trades that open the walls. Second, the permit and the inspection days. Third, hauling the old kitchen away.";
const CLOSE = "Ask for those three in writing before the cheapest quote wins. Comment BLUEPRINT and I'll send you the checklist.";

function remixPackage(over: Partial<ScriptPackageInput> = {}): ScriptPackageInput {
  const beats = over.beats ?? [
    { role: "hook" as const, text: HOOK },
    { role: "proof" as const, text: PROOF },
    { role: "play" as const, text: PLAY },
    { role: "close" as const, text: CLOSE },
  ];
  return {
    title: "The cheap quote is missing three things",
    body: beats.map((b) => b.text).join(" "),
    beats,
    hookText: HOOK,
    hookSource: { hookId: null, pattern: "cost-of-mistake", origin: "competitor", ref: "https://www.instagram.com/reel/demo/" },
    cta: { type: "comment_keyword", keyword: "blueprint" },
    claimLedger: [
      { id: "c1", claim: "We tracked 42 projects last year", verdict: "PASS", source: "proof:project-tracker" },
      { id: "c2", claim: "Fixed-scope projects finished 18 percent under the first quote", verdict: "PASS", source: "proof:project-tracker" },
    ],
    captions: validCaptions(),
    ...over,
  };
}

const REMIX: RemixRules = {
  sourceText: SOURCE_TEXT,
  hookLine: SOURCE_HOOK,
  theirTerms: ["@demo_creator_a", "Rowan", "Maple and Oak"],
  sourceBeats: 4,
  sourceWords: 70,
};
const RULES: ScriptRules = { claimSources: SOURCES, minSeconds: 10, remix: REMIX };
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);
const warnCodes = (r: { warnings: { code: string }[] }) => r.warnings.map((e) => e.code);

describe("longestSharedRun", () => {
  it("finds the longest run of shared words, case and punctuation aside", () => {
    expect(longestSharedRun("I'll send you the checklist, today", "Comment and I'll send you the CHECKLIST.")).toEqual({ length: 5, words: ["i'll", "send", "you", "the", "checklist"] });
    expect(longestSharedRun("", "anything").length).toBe(0);
    expect(longestSharedRun("totally different words", "nothing alike here").length).toBe(0);
  });
});

describe("remix scripts", () => {
  it("a close adaptation passes: same hook wording, the source's beats only, no full 6-beat skeleton", () => {
    const r = validateScript(remixPackage(), RULES);
    expect(r.errors).toEqual([]);
    // The skipped skeleton beats are advice, not failures.
    expect(warnCodes(r)).toContain("beats.missing");
  });

  it("the same draft as an original still needs the full skeleton", () => {
    const r = validateScript(remixPackage(), { ...RULES, remix: undefined });
    expect(codes(r)).toContain("beats.missing");
  });

  it("keeps the source's beat order without failing the skeleton order", () => {
    const pkg = remixPackage({
      beats: [
        { role: "hook", text: HOOK },
        { role: "play", text: PLAY },
        { role: "proof", text: PROOF },
        { role: "close", text: CLOSE },
      ],
    });
    expect(codes(validateScript(pkg, RULES))).not.toContain("beats.order");
    expect(warnCodes(validateScript(pkg, RULES))).toContain("beats.order");
    expect(codes(validateScript(pkg, { ...RULES, remix: undefined }))).toContain("beats.order");
  });

  it("still opens with the hook and ends with the close", () => {
    const pkg = remixPackage({ beats: [{ role: "proof", text: PROOF }, { role: "hook", text: HOOK }, { role: "close", text: CLOSE }] });
    expect(codes(validateScript(pkg, RULES))).toContain("beats.order");
  });

  it("fails the creator's handle, name or brand anywhere: script, hook, title or captions", () => {
    const body = remixPackage({ beats: [{ role: "hook", text: HOOK }, { role: "proof", text: `${PROOF} Rowan says the same.` }, { role: "play", text: PLAY }, { role: "close", text: CLOSE }] });
    expect(codes(validateScript(body, RULES))).toContain("remix.their_term");
    const caps = validCaptions();
    caps.instagram.caption = `${caps.instagram.caption} Inspired by @demo_creator_a.`;
    const r = checkRemix(remixPackage({ captions: caps }) as never, REMIX);
    expect(r.errors[0]).toMatchObject({ code: "remix.their_term", path: "captions.instagram.caption" });
    // A handle said out loud ("demo creator a") counts too.
    const spoken = remixPackage({ title: "Like demo creator a does it" });
    expect(codes(checkRemix(spoken as never, REMIX))).toContain("remix.their_term");
    // Their keyword in capitals is theirs; the plain word ("quote") is everyone's.
    expect(codes(checkRemix(remixPackage() as never, { ...REMIX, theirTerms: ["QUOTE"] }))).toEqual([]);
    const sameKeyword = remixPackage({ beats: [{ role: "hook", text: HOOK }, { role: "proof", text: PROOF }, { role: "play", text: PLAY }, { role: "close", text: "Comment QUOTE and I'll send you the checklist." }] });
    expect(codes(checkRemix(sameKeyword as never, { ...REMIX, theirTerms: ["QUOTE"] }))).toEqual(["remix.their_term"]);
  });

  it("allows the hook to track the source closely but fails long passages read back after it", () => {
    const verbatimHook = remixPackage({
      hookText: SOURCE_HOOK,
      beats: [{ role: "hook", text: SOURCE_HOOK }, { role: "proof", text: PROOF }, { role: "play", text: PLAY }, { role: "close", text: CLOSE }],
    });
    expect(codes(checkRemix(verbatimHook as never, REMIX))).toEqual([]);

    const copied = "Comment QUOTE and I will send you the checklist we use for every single cabinet quote we look at";
    const lifted = remixPackage({ beats: [{ role: "hook", text: HOOK }, { role: "proof", text: PROOF }, { role: "play", text: `${PLAY} ${copied} and more.` }, { role: "close", text: CLOSE }] });
    const r = checkRemix(lifted as never, { ...REMIX, copiedRunError: 15 });
    expect(r.errors[0]).toMatchObject({ code: "remix.copied_run", path: "body" });

    const phrase = remixPackage({ beats: [{ role: "hook", text: HOOK }, { role: "proof", text: PROOF }, { role: "play", text: `${PLAY} Nobody had priced hauling the old boxes away in time.` }, { role: "close", text: CLOSE }] });
    const w = checkRemix(phrase as never, { ...REMIX, copiedRunWarn: 6 });
    expect(codes(w)).toEqual([]);
    expect(warnCodes(w)).toContain("remix.copied_run");
  });

  it("fails the creator's numbers unless the owner's proof inventory backs them", () => {
    const theirs = remixPackage({
      beats: [{ role: "hook", text: HOOK }, { role: "proof", text: "We fixed one for 14000 dollars last spring." }, { role: "play", text: PLAY }, { role: "close", text: CLOSE }],
      claimLedger: [{ id: "c1", claim: "We fixed one for 14000 dollars", verdict: "PASS", source: "https://www.instagram.com/reel/demo/" }],
    });
    expect(codes(checkRemix(theirs as never, REMIX))).toEqual(["remix.source_number"]);
    // The same value backed by the owner's own proof item is fine.
    const ours = remixPackage({ claimLedger: [{ id: "c1", claim: "We tracked 42 projects", verdict: "PASS", source: "proof:project-tracker" }] });
    expect(codes(checkRemix(ours as never, { ...REMIX, sourceText: `${SOURCE_TEXT} We did 42 of them.` }))).toEqual([]);
  });

  it("keeps every hard rule: banned phrases, unbacked numbers, the CTA and the length window", () => {
    const banned = remixPackage();
    expect(codes(validateScript(banned, { ...RULES, bannedPhrases: ["missing three things"] }))).toContain("script.banned_phrase");
    const unbacked = remixPackage({ claimLedger: [] });
    expect(codes(validateScript(unbacked, RULES))).toContain("claims.unlisted_number");
    const noCta = remixPackage({ beats: [{ role: "hook", text: HOOK }, { role: "proof", text: PROOF }, { role: "play", text: PLAY }, { role: "close", text: "Ask for those three in writing before the cheapest quote wins." }] });
    expect(codes(validateScript(noCta, RULES))).toContain("cta.mismatch");
    expect(codes(validateScript(remixPackage(), { ...RULES, minSeconds: 60 }))).toContain("length.too_short");
  });

  it("warns when the draft drifts from what worked: hook, length, beat count", () => {
    const drifted = remixPackage({
      hookText: "Homeowners love open kitchens these days.",
      beats: [{ role: "hook", text: "Homeowners love open kitchens these days." }, { role: "proof", text: PROOF }, { role: "play", text: PLAY }, { role: "close", text: CLOSE }],
    });
    const r = checkRemix(drifted as never, { ...REMIX, sourceWords: 200, sourceBeats: 9 });
    expect(r.errors).toEqual([]);
    expect(warnCodes(r)).toEqual(expect.arrayContaining(["remix.hook_drifted", "remix.length_drifted", "remix.beats_drifted"]));
    expect(warnCodes(checkRemix(remixPackage() as never, REMIX))).toEqual([]);
  });

  it("fails a remix written without its source's blueprint", () => {
    const r = validateScript(remixPackage(), { ...RULES, remix: { ...REMIX, blueprintMissing: true } });
    expect(codes(r)).toContain("remix.no_blueprint");
  });

  it("lets the hook run as long as the source's hook did, and a proof without a number only warns", () => {
    const longHook = "I'm the only designer in my studio and this is the exact planning system that keeps every room on time.";
    const pkg = remixPackage({
      hookText: longHook,
      beats: [{ role: "hook", text: longHook }, { role: "proof", text: "Every morning the plan checks each open room and flags what's late." }, { role: "play", text: PLAY }, { role: "close", text: CLOSE }],
    });
    const asOriginal = validateScript(pkg, { claimSources: SOURCES, minSeconds: 10, remix: { ...REMIX, hookLine: SOURCE_HOOK } });
    expect(codes(asOriginal)).toContain("hook.too_slow");
    const sourceHook = "I'm the only builder on my crew and this is the exact checklist that keeps every job on time.";
    const r = validateScript(pkg, { ...RULES, remix: { ...REMIX, hookLine: sourceHook } });
    expect(codes(r)).not.toContain("hook.too_slow");
    expect(codes(r)).not.toContain("beats.proof_without_number");
    expect(warnCodes(r)).toContain("beats.proof_without_number");
  });
});

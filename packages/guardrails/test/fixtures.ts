import type { ClaimSources, ScriptPackageInput, ScriptRules } from "../src/index.ts";

/** Fixtures use the fictional demo brand "Examplebrand Studio", a design-build consultancy. */

export const HOOK = "Your remodel budget breaks before demolition even starts.";
export const TURN = "The cabinets and counters get the blame. The real leak is the plan you signed off on in week one.";
export const PROOF = "Last year we tracked 42 projects, and the ones with a fixed scope finished 18 percent under the first quote.";
export const REHOOK = "And the worst overrun on our list started with one missing line in that plan.";
export const PLAY =
  "Before you sign anything, ask for three things in writing. A fixed scope for every room. A price list for change orders. " +
  "And a weekly cost update you can read over coffee. If a builder won't put those on paper, keep looking, because that missing line is where the money goes.";
export const CLOSE = "Get those three in writing and your budget holds past demolition. Comment BLUEPRINT and I'll send you the checklist.";

export function validCaptions() {
  return {
    instagram: {
      caption: "Your remodel budget breaks in week one, not at demolition. Comment BLUEPRINT and I'll send you the checklist.",
      hashtags: ["#kitchenremodel", "#designbuild", "#remodelingtips", "#homerenovation"],
    },
    tiktok: {
      caption: "Three things to get in writing before your remodel starts. DM me BLUEPRINT for the checklist.",
      hashtags: ["#kitchenremodel", "#designbuild", "#remodelingtips"],
    },
    youtube: {
      title: "Why remodel budgets break before demolition",
      description: "Three things to get in writing before you sign. Link in bio for the checklist.",
      hashtags: ["#kitchenremodel", "#designbuild", "#remodelingtips"],
    },
    facebook: {
      caption: "Three things to get in writing before your remodel starts. Link in bio for the checklist.",
      hashtags: ["#kitchenremodel", "#designbuild", "#remodelingtips"],
    },
    linkedin: {
      text: "Most remodel overruns start with the plan, not the build.\n\nGet a fixed scope, a change order price list and a weekly cost update in writing before you sign.",
      hashtags: ["#designbuild", "#construction", "#remodeling"],
    },
    x: {
      text: "Remodel budgets break in week one. Get scope, change order prices and weekly cost updates in writing before you sign.",
      hashtags: ["#designbuild"],
    },
  };
}

export function validPackage(): ScriptPackageInput {
  const beats = [
    { role: "hook" as const, text: HOOK },
    { role: "turn" as const, text: TURN },
    { role: "proof" as const, text: PROOF },
    { role: "rehook" as const, text: REHOOK },
    { role: "play" as const, text: PLAY },
    { role: "close" as const, text: CLOSE },
  ];
  return {
    title: "Why remodel budgets break early",
    body: beats.map((b) => b.text).join(" "),
    beats,
    hookText: HOOK,
    hookSource: { hookId: "11111111-1111-4111-8111-111111111111", pattern: "cost-of-mistake", origin: "own" },
    cta: { type: "comment_keyword", keyword: "blueprint" },
    claimLedger: [
      { id: "c1", claim: "We tracked 42 projects last year", verdict: "PASS", source: "proof:project-tracker" },
      { id: "c2", claim: "Fixed-scope projects finished 18 percent under the first quote", verdict: "PASS", source: "proof:project-tracker" },
    ],
    captions: validCaptions(),
  };
}

export const SOURCES: ClaimSources = {
  proof: [
    {
      id: "project-tracker",
      title: "Project tracker, last year",
      numbers: [
        { value: "42", label: "projects tracked" },
        { value: "18%", label: "fixed-scope projects under first quote" },
      ],
    },
  ],
  cited: [
    { id: "trend-1", url: "https://example.com/remodel-costs", title: "Remodel cost report", numbers: ["27%"] },
    { id: "trend-2", url: "https://example.com/two-sources", corroborated: true },
  ],
};

export function rules(over: Partial<ScriptRules> = {}): ScriptRules {
  return {
    bannedPhrases: ["dream home"],
    keywordLedger: ["guide", "estimate"],
    claimSources: SOURCES,
    ...over,
  };
}

/** Rebuilds the package with one beat's text replaced (body kept in sync). */
export function withBeat(role: "hook" | "turn" | "proof" | "rehook" | "play" | "close", text: string): ScriptPackageInput {
  const pkg = validPackage();
  const beats = pkg.beats.map((b) => (b.role === role ? { ...b, text } : b));
  return { ...pkg, beats, body: beats.map((b) => b.text).join(" "), hookText: role === "hook" ? text : pkg.hookText };
}

export const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);
export const warnCodes = (r: { warnings: { code: string }[] }) => r.warnings.map((e) => e.code);

import { describe, expect, it } from "vitest";
import {
  back,
  completeStep,
  goTo,
  initialState,
  isFinished,
  nextStep,
  onboardingStateSchema,
  parseState,
  prevStep,
  progress,
  skipStep,
  STEP_IDS,
  stepStatus,
} from "../src/lib/state.ts";

const NOW = new Date("2026-10-12T09:00:00Z");

describe("onboarding state machine", () => {
  it("starts at the welcome step with empty sections", () => {
    const s = initialState(NOW);
    expect(s.step).toBe("welcome");
    expect(s.completed).toEqual([]);
    expect(s.data.startedAt).toBe(NOW.toISOString());
    expect(s.data.business.url).toBe("");
    expect(s.data.interview.messages).toEqual([]);
    expect(isFinished(s)).toBe(false);
  });

  it("walks forward and back through every step", () => {
    expect(STEP_IDS).toEqual(["welcome", "you", "keys", "competitors", "start", "review", "go-live"]);
    expect(nextStep("welcome")).toBe("you");
    expect(nextStep("go-live")).toBe("go-live");
    expect(prevStep("welcome")).toBe("welcome");
    expect(prevStep("you")).toBe("welcome");
    let s = initialState(NOW);
    for (const step of STEP_IDS.slice(0, -1)) s = completeStep(s, step, NOW);
    expect(s.step).toBe("go-live");
    expect(s.completed).toHaveLength(STEP_IDS.length - 1);
    s = back(s);
    expect(s.step).toBe("review");
  });

  it("keeps the interview outside the rail: it opens from Review and returns there", () => {
    let s = goTo(completeStep(goTo(initialState(NOW), "start"), "start", NOW), "interview");
    expect(s.step).toBe("interview");
    expect(prevStep("interview")).toBe("review");
    s = completeStep(s, "interview", NOW);
    expect(s.step).toBe("review");
    expect(s.completed).toEqual(["start", "interview"]);
    // Doing the optional interview doesn't move the progress line past the main steps.
    expect(progress(s)).toBeLessThan(1);
  });

  it("finishes setup when go-live is completed or skipped", () => {
    const done = completeStep(goTo(initialState(NOW), "go-live"), "go-live", NOW);
    expect(isFinished(done)).toBe(true);
    expect(done.data.finishedAt).toBe(NOW.toISOString());
    expect(progress(done)).toBe(1);
    const later = skipStep(goTo(initialState(NOW), "go-live"), "go-live", NOW);
    expect(isFinished(later)).toBe(true);
  });

  it("skipping keeps defaults and is undone by completing the step later", () => {
    let s = skipStep(goTo(initialState(NOW), "keys"), "keys", NOW);
    expect(s.step).toBe("competitors");
    expect(s.data.skipped).toEqual(["keys"]);
    expect(stepStatus(s, "keys")).toBe("skipped");
    s = completeStep(goTo(s, "keys"), "keys", NOW);
    expect(s.data.skipped).toEqual([]);
    expect(s.completed).toEqual(["keys"]);
    expect(stepStatus(s, "keys")).toBe("done");
  });

  it("never double-counts and keeps completed steps in order", () => {
    let s = initialState(NOW);
    s = completeStep(s, "competitors", NOW);
    s = completeStep(s, "you", NOW);
    s = completeStep(s, "you", NOW);
    expect(s.completed).toEqual(["you", "competitors"]);
    // Skipping a step that's already done doesn't mark it skipped.
    s = skipStep(goTo(s, "you"), "you", NOW);
    expect(s.data.skipped).toEqual([]);
  });

  it("progress grows as steps are done or skipped", () => {
    const s0 = initialState(NOW);
    const s1 = completeStep(s0, "welcome", NOW);
    const s2 = skipStep(s1, "you", NOW);
    expect(progress(s0)).toBe(0);
    expect(progress(s1)).toBeGreaterThan(progress(s0));
    expect(progress(s2)).toBeGreaterThan(progress(s1));
    expect(progress(s2)).toBeLessThan(1);
  });

  it("parses stored values and survives junk without losing the step", () => {
    const stored = JSON.parse(JSON.stringify(completeStep(initialState(NOW), "welcome", NOW)));
    expect(parseState(stored).step).toBe("you");
    expect(parseState(null).step).toBe("welcome");
    const junk = parseState({ step: "interview", completed: ["welcome", "nope"], data: { business: { draft: { name: 42 } }, content: { handles: { tiktok: "@examplebrand" } } } }, NOW);
    expect(junk.step).toBe("interview");
    expect(junk.completed).toEqual(["welcome"]);
    expect(junk.data.business.draft).toBeUndefined();
    // Sections that still validate are kept.
    expect(junk.data.content.handles.tiktok).toBe("@examplebrand");
  });

  it("resumes a setup saved by the first wizard on the matching new step", () => {
    const old = { step: "strategy", completed: ["welcome", "business", "content", "interview"], data: { skipped: ["formats", "connect"], business: { url: "examplebrand.example" } } };
    const s = parseState(old, NOW);
    expect(s.step).toBe("competitors");
    expect(s.completed).toEqual(["welcome", "you", "interview"]);
    expect(s.data.skipped).toEqual(["review", "keys"]);
    expect(s.data.business.url).toBe("examplebrand.example");
    expect(s.data.start.runIds).toEqual([]);
    expect(s.data.strategy.competitors).toEqual([]);
  });

  it("validates the stored shape { step, completed, data }", () => {
    const s = onboardingStateSchema.parse({ step: "keys", completed: ["welcome"], data: { content: { handles: { instagram: "@examplebrand" } } } });
    expect(Object.keys(s).sort()).toEqual(["completed", "data", "step"]);
    expect(s.data.content.handles.instagram).toBe("@examplebrand");
    expect(() => onboardingStateSchema.parse({ step: "nowhere" })).toThrow();
  });
});

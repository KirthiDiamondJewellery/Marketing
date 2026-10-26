import { describe, expect, it } from "vitest";
import { draftPlan, formatCutOptions, listFormats, loadFormat, parseEditMap, validateEditPlan, FormatError } from "../src/index.ts";

describe("format templates", () => {
  it("ships the four v0.1 formats, all valid", () => {
    expect(listFormats()).toEqual(["news-greenscreen", "popup-presenter", "raw-talking-head", "split-demo"]);
    for (const id of listFormats()) {
      const f = loadFormat(id);
      expect(f.id).toBe(id);
      expect(f.shoot).toMatch(/^# Shoot:/);
      expect(f.shoot).toMatch(/\*\*Framing/);
      expect(f.broll.stills).toBeLessThanOrEqual(8);
      expect(f.broll.loops).toBeLessThanOrEqual(6);
      expect(f.pacing.maxPauseS).toBeLessThanOrEqual(0.15);
      for (const slot of f.overlaySlots) if (["chart", "screenshot", "post-card"].includes(slot.kind)) expect(slot.evidenceRequired).toBe(true);
      expect(formatCutOptions(f)).toMatchObject({ strictDb: -42, broadDb: -35 });
    }
  });

  it("explains unknown formats", () => {
    expect(() => loadFormat("nope")).toThrow(FormatError);
    expect(() => loadFormat("../etc")).toThrow(/not a format id/);
  });

  it("drafts a plan that passes the schema", () => {
    const editMap = parseEditMap({
      version: 1, status: "approved", fps: 30, source: { path: "/tmp/p.mp4", durationS: 12 },
      keepRanges: [{ start: 0.4, end: 5 }, { start: 6, end: 11 }], cuts: [{ start: 5, end: 6, kind: "silence", reason: "Pause." }],
      stats: { sourceS: 12, outputS: 9.6, removedS: 2.4, cutCount: 1 },
    });
    for (const id of listFormats()) {
      const plan = draftPlan({ format: loadFormat(id), editMap, transcript: { language: "en", words: [{ text: "hi", start: 0.5, end: 0.8 }] }, source: { path: "/tmp/p.mp4", durationS: 12 }, houseStyle: "brand/house-style.md" });
      const r = validateEditPlan(plan);
      expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
    }
  });
});

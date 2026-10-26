import { describe, expect, it } from "vitest";
import { applyEditMapChanges, approveEditMap, editMapTimeMap, parseEditMap, summarizeEditMap, type EditMap } from "../src/index.ts";

const base = (): EditMap =>
  parseEditMap({
    version: 1,
    status: "review",
    fps: 30,
    source: { path: "/tmp/proxy.mp4", durationS: 10 },
    keepRanges: [{ start: 0.5, end: 4 }, { start: 5, end: 9 }],
    cuts: [
      { start: 0, end: 0.5, kind: "lead_in", reason: "Lead-in before the first word (0.50s)." },
      { start: 4, end: 5, kind: "silence", reason: "Pause of 1.10s (both detectors agree)." },
      { start: 9, end: 10, kind: "tail", reason: "Dead tail after the last word (1.00s)." },
    ],
    stats: { sourceS: 10, outputS: 7.5, removedS: 2.5, cutCount: 3 },
  });

describe("edit map", () => {
  it("restores a cut and adds a manual one, keeping keep ranges and stats consistent", () => {
    const m = applyEditMapChanges(base(), { restore: [1], add: [{ start: 2.01, end: 2.49, reason: "Off-topic aside." }] });
    expect(m.cuts.map((c) => c.kind)).toEqual(["lead_in", "manual", "tail"]);
    expect(m.cuts[1]).toMatchObject({ start: 2, end: 2.5 });
    expect(m.keepRanges).toEqual([{ start: 0.5, end: 2 }, { start: 2.5, end: 9 }]);
    expect(m.stats.outputS).toBe(8);
    expect(editMapTimeMap(m).outputFrames).toBe(240);
  });

  it("rejects bad changes", () => {
    expect(() => applyEditMapChanges(base(), { restore: [7] })).toThrow(/no cut #8/);
    expect(() => applyEditMapChanges(base(), { add: [{ start: 3, end: 3.01 }] })).toThrow(/empty/);
  });

  it("approves and summarises", () => {
    const m = approveEditMap(base(), "user:owner", new Date("2026-10-12T10:00:00Z"));
    expect(m).toMatchObject({ status: "approved", approvedBy: "user:owner", approvedAt: "2026-10-12T10:00:00.000Z" });
    expect(summarizeEditMap(m)).toBe("Cut 1 lead-in, 1 pause, 1 dead tail: 10.0s → 7.5s.");
  });
});

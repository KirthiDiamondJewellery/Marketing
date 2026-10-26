import { describe, expect, it } from "vitest";
import { dueSnapshots, nextSnapshotAt } from "../src/schedule.ts";

const P = new Date("2026-10-01T12:00:00Z");
const at = (h: number) => new Date(P.getTime() + h * 3_600_000);

describe("snapshot schedule", () => {
  it("makes each label due inside its window only", () => {
    expect(dueSnapshots(P, at(0.5), new Set())).toEqual([]);
    expect(dueSnapshots(P, at(1), new Set())).toEqual(["1h"]);
    expect(dueSnapshots(P, at(3), new Set())).toEqual(["1h"]);
    expect(dueSnapshots(P, at(3.1), new Set())).toEqual([]);
    expect(dueSnapshots(P, at(24), new Set(["1h"]))).toEqual(["24h"]);
    expect(dueSnapshots(P, at(80), new Set(["1h", "24h"]))).toEqual(["72h"]);
    expect(dueSnapshots(P, at(170), new Set(["1h", "24h", "72h"]))).toEqual(["7d"]);
    expect(dueSnapshots(P, at(721), new Set())).toEqual(["30d"]);
    expect(dueSnapshots(P, at(900), new Set())).toEqual([]);
  });
  it("never repeats a captured label", () => {
    expect(dueSnapshots(P, at(1.5), new Set(["1h"]))).toEqual([]);
  });
  it("skips labels whose window passed instead of filling them late", () => {
    // Captured nothing for 30 hours: the 1h label is gone, 24h is due.
    expect(dueSnapshots(P, at(30), new Set())).toEqual(["24h"]);
  });
  it("tells when the next capture is", () => {
    expect(nextSnapshotAt(P, at(0), new Set())).toEqual({ label: "1h", at: at(1) });
    expect(nextSnapshotAt(P, at(5), new Set(["1h"]))).toEqual({ label: "24h", at: at(24) });
    expect(nextSnapshotAt(P, at(5), new Set())).toEqual({ label: "24h", at: at(24) });
    expect(nextSnapshotAt(P, at(1000), new Set())).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { TimeMap, outputRange, overlaps, sourceRange, src, toFrame, out } from "../src/index.ts";

describe("TimeMap", () => {
  it("quantises like media-py (Math.round, not banker's rounding)", () => {
    expect(toFrame(0.05, 30)).toBe(2);
    expect(toFrame(0.35, 30)).toBe(11);
    expect(toFrame(1.1, 30)).toBe(33);
  });

  it("round-trips every kept frame", () => {
    const tm = TimeMap.fromKeepRanges([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4.5, end: 5 }], 30, 6);
    expect(tm.outputFrames).toBe(75);
    for (const k of tm.keeps) {
      for (let f = k.srcStart; f < k.srcEnd; f++) {
        const o = tm.srcToOut(f);
        expect(o).not.toBeNull();
        expect(tm.outToSrc(o!)).toBe(f);
      }
    }
    expect(tm.srcToOut(45)).toBeNull();
    expect(tm.srcToOutSnap(45)).toBe(30);
    expect(tm.toOutput(src(2.5))).toBeCloseTo(1.5, 9);
    expect(tm.toSource(out(1.5))).toBeCloseTo(2.5, 9);
  });

  it("merges overlapping/adjacent ranges and clamps to the source (same result as media-py)", () => {
    const tm = TimeMap.fromKeepRanges([{ start: 1, end: 2 }, { start: 0.5, end: 1.2 }, { start: 2, end: 2.5 }, { start: 5.8, end: 9 }], 30, 6);
    expect(tm.keeps.map((k) => [k.srcStart, k.srcEnd])).toEqual([[15, 75], [174, 180]]);
    expect(tm.outputFrames).toBe(66);
  });

  it("handles empty and degenerate input", () => {
    const tm = TimeMap.fromKeepRanges([], 30, 5);
    expect(tm.outputFrames).toBe(0);
    expect(tm.outputRangeToSource(outputRange(0, 1))).toEqual([]);
    expect(tm.outToSrc(3)).toBe(0);
    expect(TimeMap.fromKeepRanges([{ start: 1, end: 1 }], 30, 5).keeps).toEqual([]);
    expect(() => TimeMap.fromKeepRanges([], 0, 5)).toThrow();
  });

  it("maps a source range spanning a cut to two output ranges, and back", () => {
    const tm = TimeMap.fromKeepRanges([{ start: 0, end: 1 }, { start: 2, end: 3 }], 30, 3);
    expect(tm.sourceRangeToOutput(sourceRange(20 / 30, 70 / 30)).map((r) => [r.start * 30, r.end * 30].map(Math.round))).toEqual([[20, 30], [30, 40]]);
    expect(tm.outputRangeToSource(outputRange(25 / 30, 35 / 30)).map((r) => [r.start * 30, r.end * 30].map(Math.round))).toEqual([[25, 30], [60, 65]]);
  });

  it("maps words and drops cut ones", () => {
    const tm = TimeMap.fromKeepRanges([{ start: 0, end: 1 }, { start: 2, end: 3 }], 30, 3);
    const words = tm.mapWords([
      { text: "kept", start: 2.1, end: 2.4 },
      { text: "cut", start: 1.2, end: 1.8 },
      { text: "straddles", start: 0.9, end: 2.2 },
    ]);
    expect(words.map((w) => w.text)).toEqual(["kept", "straddles"]);
    expect(words[0]!.start).toBeCloseTo(1.1, 9);
    expect(words[1]!.end).toBeCloseTo(1.2, 9);
  });

  it("builds from drops and reports dropped ranges and joins", () => {
    const tm = TimeMap.fromDrops([{ start: 1, end: 2 }, { start: 4, end: 4.5 }], 30, 5);
    expect(tm.keepRanges().map((r) => [r.start, r.end])).toEqual([[0, 1], [2, 4], [4.5, 5]]);
    expect(tm.droppedRanges().map((r) => [r.start, r.end])).toEqual([[1, 2], [4, 4.5]]);
    expect(tm.joins().map(Number)).toEqual([1, 3]);
  });

  it("makes comparing source pauses with output beats a type error (the ported bug class)", () => {
    const tm = TimeMap.fromKeepRanges([{ start: 0, end: 2 }, { start: 3, end: 6 }], 30, 6);
    const pause = sourceRange(4.0, 4.4);
    const beat = outputRange(2.9, 3.6);
    // @ts-expect-error: a source-time pause cannot be compared with an output-time beat
    overlaps(pause, beat);
    const mapped = tm.sourceRangeToOutput(pause);
    expect(mapped.map((r) => [r.start, r.end])).toEqual([[3, 3.4]]);
    expect(mapped.some((r) => overlaps(r, beat))).toBe(true);
    // the naive comparison (what the old code did) misses the overlap
    expect(pause.start < beat.end && pause.end > beat.start).toBe(false);
  });
});

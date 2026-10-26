import { describe, expect, it } from "vitest";
import { clamp, hashString, median, medianCi, pickWeighted, quantile, round, seededRandom } from "../src/index.ts";

describe("median", () => {
  it("handles odd, even, empty and non-finite input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
    expect(median([null, 5, undefined])).toBe(5);
  });
  it("does not mutate the input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("quantile", () => {
  it("interpolates and clamps q", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([1, 2], -1)).toBe(1);
    expect(quantile([1, 2], 2)).toBe(2);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("medianCi", () => {
  it("widens to [min, max] for tiny samples", () => {
    expect(medianCi([2, 1, 3], 0.9)).toEqual([1, 3]);
    expect(medianCi([5], 0.9)).toEqual([5, 5]);
    expect(medianCi([], 0.9)).toBeNull();
  });
  it("matches the sign-test interval for n=10 at 90% (x(2)..x(9))", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(medianCi(xs, 0.9)).toEqual([2, 9]);
  });
  it("matches the sign-test interval for n=20 at 95% (x(6)..x(15))", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(medianCi(xs, 0.95)).toEqual([6, 15]);
  });
  it("narrows as n grows and always contains the median", () => {
    const small = Array.from({ length: 15 }, (_, i) => i);
    const big = Array.from({ length: 301 }, (_, i) => i / 20);
    const [sl, sh] = medianCi(small)!;
    const [bl, bh] = medianCi(big)!;
    expect((sh - sl) / 14).toBeGreaterThan((bh - bl) / 15);
    expect(bl).toBeLessThanOrEqual(median(big)!);
    expect(bh).toBeGreaterThanOrEqual(median(big)!);
  });
});

describe("seeded randomness", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = seededRandom("2026-10-11:ws");
    const b = seededRandom("2026-10-11:ws");
    const c = seededRandom("2026-10-12:ws");
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
  });
  it("hashString is stable", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});

describe("pickWeighted", () => {
  const opts = [{ id: "a", weight: 9 }, { id: "b", weight: 1 }, { id: "c", weight: 0 }];
  it("exploits by weight without exploration", () => {
    const rand = seededRandom(1);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 2000; i++) counts[pickWeighted(opts, rand, 0)!.id]!++;
    expect(counts.c).toBe(0);
    expect(counts.a! / 2000).toBeGreaterThan(0.85);
  });
  it("reaches zero-weight options only through exploration", () => {
    const rand = seededRandom(2);
    let c = 0;
    for (let i = 0; i < 3000; i++) if (pickWeighted(opts, rand, 0.2)!.id === "c") c++;
    expect(c / 3000).toBeGreaterThan(0.04);
    expect(c / 3000).toBeLessThan(0.1);
  });
  it("handles empty and all-zero options", () => {
    expect(pickWeighted([], Math.random)).toBeUndefined();
    expect(pickWeighted([{ weight: 0 }], seededRandom(3), 0)).toEqual({ weight: 0 });
  });
});

it("clamp and round", () => {
  expect(clamp(5, 0, 3)).toBe(3);
  expect(clamp(-1, 0, 3)).toBe(0);
  expect(round(1.23456, 2)).toBe(1.23);
});

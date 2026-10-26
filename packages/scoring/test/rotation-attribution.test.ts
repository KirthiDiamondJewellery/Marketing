import { describe, expect, it } from "vitest";
import {
  affordablePerDay, blendWeights, classifyForPostMortem, dailyRotation, dayOfYear, daysLeftInMonth, featureAttribution,
  hookScore, isHookWin, lengthBucket, localDay, qualifiesForOwnBank, slotBucket, weightOf,
} from "../src/index.ts";

describe("dailyRotation", () => {
  const FIXED = new Date("2026-03-15T12:00:00Z"); // a pinned day, so results never depend on when the suite runs
  const list = Array.from({ length: 10 }, (_, i) => `c${i}`);
  it("moves a window of perDay by day of year and wraps", () => {
    const d1 = new Date("2026-01-01T12:00:00Z"); // doy 1
    const d2 = new Date("2026-01-02T12:00:00Z"); // doy 2
    expect(dailyRotation(list, { date: d1, perDay: 4 }).picked).toEqual(["c4", "c5", "c6", "c7"]);
    expect(dailyRotation(list, { date: d2, perDay: 4 }).picked).toEqual(["c8", "c9", "c0", "c1"]);
  });
  it("covers every creator over consecutive days", () => {
    const seen = new Set<string>();
    for (let d = 0; d < 5; d++) {
      for (const c of dailyRotation(list, { date: new Date(Date.UTC(2026, 2, 1 + d, 12)), perDay: 3 }).picked) seen.add(c);
    }
    expect(seen.size).toBe(10);
  });
  it("uses the workspace time zone for the day boundary", () => {
    const lateUtc = new Date("2026-01-02T03:00:00Z"); // still Jan 1 in New York
    expect(dayOfYear(lateUtc, "America/New_York")).toBe(1);
    expect(dayOfYear(lateUtc, "UTC")).toBe(2);
  });
  it("never picks more than the list and handles empty input", () => {
    expect(dailyRotation(["a", "b"], { date: FIXED, perDay: 5 }).picked.sort()).toEqual(["a", "b"]);
    expect(dailyRotation([], { date: FIXED, perDay: 5 }).picked).toEqual([]);
    expect(dailyRotation(["a"], { date: FIXED, perDay: 0 }).picked).toEqual([]);
  });
  it("shrinks today's window to what the budget can afford", () => {
    const r = dailyRotation(list, { date: new Date("2026-01-01T12:00:00Z"), perDay: 4, budget: { remainingUsd: 3, costPerItemUsd: 0.05, daysLeft: 30 } });
    // 3 / 30 / 0.05 = 2 per day
    expect(r.count).toBe(2);
    expect(r.limitedBy).toBe("budget");
    expect(r.picked).toEqual(["c4", "c5"]);
    expect(affordablePerDay({ remainingUsd: 0, costPerItemUsd: 0.05, daysLeft: 3 })).toBe(0);
    expect(affordablePerDay({ remainingUsd: 0, costPerItemUsd: 0, daysLeft: 3 })).toBe(Number.POSITIVE_INFINITY);
    expect(dailyRotation(list, { date: FIXED, perDay: 4, budget: { remainingUsd: 100, costPerItemUsd: 0.01, daysLeft: 1 } }).limitedBy).toBeUndefined();
  });
  it("date helpers", () => {
    expect(localDay(new Date("2026-10-11T02:00:00Z"), "America/New_York")).toBe("2026-10-10");
    expect(daysLeftInMonth(new Date("2026-10-30T12:00:00Z"))).toBe(2);
    expect(daysLeftInMonth(new Date("2026-02-01T12:00:00Z"))).toBe(28);
  });
});

describe("featureAttribution", () => {
  const rows = [
    ...[3, 2.5, 4, 3.5, 2].map((x) => ({ x, features: { lane: "proof", hook_pattern: "question" } })),
    ...[0.8, 1, 0.9, 1.1, 0.7, 1].map((x) => ({ x, features: { lane: "myth", hook_pattern: "list" } })),
    { x: 1.5, features: { lane: "offer", hook_pattern: null } },
    { x: null, features: { lane: "offer" } },
  ];
  const res = featureAttribution(rows, { minN: 5 });
  const stat = (d: string, v: string) => res.stats.find((s) => s.dimension === d && s.value === v)!;

  it("computes overall median and per-value median, lift and n", () => {
    expect(res.n).toBe(12);
    expect(res.overallMedian).toBe(1.3);
    expect(stat("lane", "proof")).toMatchObject({ n: 5, medianX: 3, lift: 2.308, sufficient: true });
    expect(stat("lane", "myth")).toMatchObject({ n: 6, medianX: 0.95, sufficient: true });
  });
  it("gives a rank-based CI and flags clear differences", () => {
    const proof = stat("lane", "proof");
    expect(proof.ciLow).toBe(2);
    expect(proof.ciHigh).toBe(4);
    expect(proof.clear).toBe(true);
    expect(proof.line).toContain('lane "proof": median 3x');
  });
  it("prints GAP lines below min n instead of guessing", () => {
    const offer = stat("lane", "offer");
    expect(offer.sufficient).toBe(false);
    expect(offer.ciLow).toBeNull();
    expect(offer.line).toBe('GAP: lane "offer" has 1 post (need 5). Not enough data to judge yet.');
    expect(res.gaps).toContain(offer.line);
  });
  it("skips missing values and unscored rows", () => {
    expect(res.stats.filter((s) => s.dimension === "hook_pattern").map((s) => s.value)).toEqual(["list", "question"]);
  });
  it("handles no data", () => {
    expect(featureAttribution([])).toEqual({ n: 0, overallMedian: null, stats: [], gaps: [] });
  });
  it("buckets length and slot", () => {
    expect(lengthBucket(10)).toBe("0-15s");
    expect(lengthBucket(44)).toBe("30-45s");
    expect(lengthBucket(120)).toBe("90s+");
    expect(lengthBucket(null)).toBeNull();
    expect(slotBucket(new Date("2026-10-11T13:00:00Z"), "America/New_York")).toBe("morning");
    expect(slotBucket(new Date("2026-10-11T03:00:00Z"), "America/New_York")).toBe("night");
    expect(slotBucket(null)).toBeNull();
  });
});

describe("blendWeights", () => {
  const own = featureAttribution(Array.from({ length: 6 }, () => ({ x: 4, features: { lane: "proof" } })).concat(
    Array.from({ length: 6 }, () => ({ x: 1, features: { lane: "myth" } }))), { minN: 5 }).stats;
  const comp = featureAttribution(Array.from({ length: 6 }, () => ({ x: 1, features: { lane: "proof" } })).concat(
    Array.from({ length: 6 }, () => ({ x: 4, features: { lane: "myth" } }))), { minN: 5 }).stats;

  it("trusts competitor data with no own posts", () => {
    const w = blendWeights({ own, competitor: comp, ownPosts: 0 });
    expect(w.ownShare).toBe(0);
    expect(w.weights.lane!.myth).toBe(1.6);
    expect(w.weights.lane!.proof).toBe(0.5);
  });
  it("trusts own data from ~20 posts and clamps", () => {
    const w = blendWeights({ own, competitor: comp, ownPosts: 25 });
    expect(w.ownShare).toBe(1);
    expect(w.weights.lane!.proof).toBe(1.6);
    expect(w.weights.lane!.myth).toBe(0.5);
  });
  it("blends halfway at 10 posts and defaults unknown values to 1", () => {
    const w = blendWeights({ own, competitor: comp, ownPosts: 10 });
    expect(w.ownShare).toBe(0.5);
    expect(w.weights.lane!.proof).toBeCloseTo(0.5 * 1.6 + 0.5 * 0.4, 3);
    expect(weightOf(w.weights, "lane", "unknown")).toBe(1);
    expect(weightOf(w.weights, "nope", "x")).toBe(1);
    expect(weightOf(w.weights, "lane", null)).toBe(1);
  });
});

describe("hook score", () => {
  it("is Laplace-smoothed, evidence-weighted and decays for competitor hooks", () => {
    expect(hookScore({ uses: 0, wins: 0, origin: "own" })).toBe(0.5);
    expect(hookScore({ uses: 4, wins: 3, originX: 3, origin: "own" })).toBeCloseTo((4 / 6) * 2, 4);
    const fresh = hookScore({ uses: 0, wins: 0, originX: 7, origin: "competitor", ageDays: 0 });
    const old = hookScore({ uses: 0, wins: 0, originX: 7, origin: "competitor", ageDays: 60 });
    expect(old).toBeCloseTo(fresh / 2, 4);
    expect(hookScore({ uses: 2, wins: 5, origin: "manual" })).toBe(hookScore({ uses: 2, wins: 2, origin: "manual" }));
  });
  it("own bank and win thresholds", () => {
    expect(qualifiesForOwnBank(3)).toBe(true);
    expect(qualifiesForOwnBank(2.99)).toBe(false);
    expect(qualifiesForOwnBank(null)).toBe(false);
    expect(isHookWin(1.5)).toBe(true);
    expect(isHookWin(1.4)).toBe(false);
  });
});

describe("post-mortem classification", () => {
  it("finds breakouts, flops and new bests", () => {
    expect(classifyForPostMortem(2.1, 5)).toBe("breakout");
    expect(classifyForPostMortem(0.59, 5)).toBe("flop");
    expect(classifyForPostMortem(1, 5)).toBeNull();
    expect(classifyForPostMortem(6, 5)).toBe("new_best");
    expect(classifyForPostMortem(1.2, 1.1)).toBe("new_best");
    expect(classifyForPostMortem(0.9, 0.5)).toBeNull();
    expect(classifyForPostMortem(3, null)).toBe("breakout");
    expect(classifyForPostMortem(null, 1)).toBeNull();
  });
});

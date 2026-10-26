import { describe, expect, it } from "vitest";
import {
  computeBaseline, isBaselineEligible, isMemeClip, resolveRule, scorePost, DEFAULT_PLATFORM_RULES, type PostSample,
} from "../src/index.ts";

const NOW = new Date("2026-10-11T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const history = (n: number, base: Partial<PostSample> = {}): PostSample[] =>
  Array.from({ length: n }, (_, i) => ({ publishedAt: daysAgo(3 + i), views: 10_000 + i * 100, comments: 40 + i, likes: 500, shares: 10, durationS: 30, ...base }));

describe("baseline", () => {
  it("uses only mature, unpinned, recent, non-meme posts", () => {
    const posts: PostSample[] = [
      ...history(5),
      { publishedAt: hoursAgo(47), views: 1_000_000, comments: 9_999 }, // too young
      { publishedAt: daysAgo(121), views: 1_000_000, comments: 9_999 }, // too old
      { publishedAt: daysAgo(5), isPinned: true, views: 1_000_000, comments: 9_999 },
      { publishedAt: daysAgo(5), durationS: 8, views: 1_000_000, comments: 9_999 }, // meme
      { publishedAt: null, views: 1_000_000 },
    ];
    const b = computeBaseline(posts, NOW);
    expect(b.n).toBe(5);
    expect(b.sufficient).toBe(true);
    expect(b.views).toBe(10_200);
    expect(b.comments).toBe(42);
    expect(b.computedAt).toBe(NOW.toISOString());
  });

  it("counts a post exactly 48h old as mature and keeps memes when asked", () => {
    expect(isBaselineEligible({ publishedAt: hoursAgo(48) }, NOW)).toBe(true);
    expect(isBaselineEligible({ publishedAt: daysAgo(3), durationS: 5 }, NOW, { excludeMemes: false })).toBe(true);
    expect(isBaselineEligible({ publishedAt: daysAgo(30) }, NOW, { maxAgeDays: 20 })).toBe(false);
  });

  it("is insufficient below minPosts and ignores missing or negative metrics per metric", () => {
    const b = computeBaseline(history(4), NOW);
    expect(b.sufficient).toBe(false);
    const withGaps = computeBaseline([...history(5, { views: undefined }), { publishedAt: daysAgo(4), views: -5, comments: 41 }], NOW);
    expect(withGaps.views).toBeNull();
    expect(withGaps.comments).toBe(41.5);
    expect(computeBaseline(history(3), NOW, { minPosts: 3 }).sufficient).toBe(true);
  });

  it("meme detection needs a known duration", () => {
    expect(isMemeClip(11.9)).toBe(true);
    expect(isMemeClip(12)).toBe(false);
    expect(isMemeClip(undefined)).toBe(false);
    expect(isMemeClip(0)).toBe(false);
  });
});

describe("instagram scoring (comment-weighted, >= 2x and >= 50 comments)", () => {
  const rule = resolveRule("instagram");
  const baseline = { views: 10_000, comments: 40, likes: 500, shares: 10, n: 10, sufficient: true, computedAt: NOW.toISOString() };

  it("computes 0.7 comment ratio + 0.3 view ratio", () => {
    const s = scorePost({ publishedAt: daysAgo(1), views: 30_000, comments: 100, durationS: 40 }, baseline, rule);
    // 0.7 * 2.5 + 0.3 * 3 = 2.65
    expect(s.x).toBe(2.65);
    expect(s.ratios).toEqual({ views: 3, comments: 2.5 });
    expect(s.isOutlier).toBe(true);
    expect(s.reason).toContain("2.65x");
  });

  it("requires the absolute comment floor", () => {
    const small = { ...baseline, comments: 10, views: 1_000 };
    const s = scorePost({ publishedAt: daysAgo(1), views: 5_000, comments: 49 }, small, rule);
    expect(s.x).toBeGreaterThan(2);
    expect(s.floorsMet).toBe(false);
    expect(s.isOutlier).toBe(false);
    expect(s.reason).toContain("floor");
    expect(scorePost({ publishedAt: daysAgo(1), views: 5_000, comments: 50 }, small, rule).isOutlier).toBe(true);
  });

  it("falls back to the comment ratio when views are missing", () => {
    const s = scorePost({ publishedAt: daysAgo(1), comments: 120 }, baseline, rule);
    expect(s.x).toBe(3);
  });

  it("is exactly at threshold at 2x", () => {
    expect(scorePost({ publishedAt: daysAgo(1), views: 20_000, comments: 80 }, baseline, rule).isOutlier).toBe(true);
    expect(scorePost({ publishedAt: daysAgo(1), views: 19_000, comments: 79 }, baseline, rule).isOutlier).toBe(false);
  });

  it("never marks memes as outliers", () => {
    const s = scorePost({ publishedAt: daysAgo(1), views: 900_000, comments: 5_000, durationS: 7 }, baseline, rule);
    expect(s.isMeme).toBe(true);
    expect(s.isOutlier).toBe(false);
    expect(s.x).toBeGreaterThan(10);
    expect(s.reason).toContain("meme");
  });

  it("returns no x without a sufficient baseline", () => {
    expect(scorePost({ publishedAt: daysAgo(1), comments: 500 }, null, rule).x).toBeNull();
    expect(scorePost({ publishedAt: daysAgo(1), comments: 500 }, { ...baseline, sufficient: false }, rule).x).toBeNull();
  });

  it("divides by at least 1 when the baseline median is 0", () => {
    const zero = { ...baseline, comments: 0, views: null };
    expect(scorePost({ publishedAt: daysAgo(1), comments: 60 }, zero, rule).x).toBe(60);
  });
});

describe("tiktok scoring (view-weighted, >= 5x and >= 20k views)", () => {
  const rule = resolveRule("tiktok");
  const baseline = { views: 4_000, comments: 20, likes: 300, shares: 5, n: 12, sufficient: true, computedAt: NOW.toISOString() };
  it("flags 5x with the view floor", () => {
    expect(scorePost({ publishedAt: daysAgo(1), views: 20_000, durationS: 25 }, baseline, rule).isOutlier).toBe(true);
    expect(scorePost({ publishedAt: daysAgo(1), views: 19_999, durationS: 25 }, baseline, rule).isOutlier).toBe(false);
  });
  it("needs both: a 10x post under 20k views is not an outlier", () => {
    const tiny = { ...baseline, views: 1_000 };
    const s = scorePost({ publishedAt: daysAgo(1), views: 10_000, durationS: 25 }, tiny, rule);
    expect(s.x).toBe(10);
    expect(s.isOutlier).toBe(false);
  });
  it("fails the floor and has no x when views are missing", () => {
    const s = scorePost({ publishedAt: daysAgo(1), comments: 999 }, baseline, rule);
    expect(s.x).toBeNull();
    expect(s.floorsMet).toBe(false);
  });
});

describe("other platforms and overrides", () => {
  it("has a rule for every platform", () => {
    for (const p of Object.keys(DEFAULT_PLATFORM_RULES)) expect(resolveRule(p as never).threshold).toBeGreaterThan(0);
  });
  it("youtube and linkedin defaults behave sensibly", () => {
    const b = { views: 5_000, comments: 20, likes: 200, shares: 10, n: 10, sufficient: true, computedAt: "" };
    expect(scorePost({ publishedAt: daysAgo(1), views: 20_000, comments: 60 }, b, resolveRule("youtube")).isOutlier).toBe(true);
    expect(scorePost({ publishedAt: daysAgo(1), likes: 600, comments: 60 }, b, resolveRule("linkedin")).isOutlier).toBe(true);
    expect(scorePost({ publishedAt: daysAgo(1), likes: 600, comments: 19 }, b, resolveRule("linkedin")).isOutlier).toBe(false);
  });
  it("applies per-platform overrides", () => {
    const r = resolveRule("instagram", { instagram: { threshold: 3, floors: {} } });
    expect(r.threshold).toBe(3);
    expect(r.floors).toEqual({});
    expect(r.weights).toEqual(DEFAULT_PLATFORM_RULES.instagram.weights);
  });
});

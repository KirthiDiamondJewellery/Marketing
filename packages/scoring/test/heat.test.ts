import { describe, expect, it } from "vitest";
import { computeHeat, engagementOf, selectTrendPicks, shouldFollowUp, velocityLabel, velocityOf } from "../src/index.ts";

const NOW = new Date("2026-10-11T12:00:00Z");
const hAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("engagement and velocity", () => {
  it("weights per source", () => {
    expect(engagementOf("hn", { points: 100, comments: 40 })).toBe(120);
    expect(engagementOf("reddit", { points: 100, comments: 40 })).toBe(140);
    expect(engagementOf("github", { points: 300, comments: 40 })).toBe(300);
    expect(engagementOf("rss", {})).toBe(0);
  });
  it("uses the recent rate between snapshots >= 45 min apart", () => {
    expect(velocityOf({ engagement: 500, publishedAt: hAgo(10), now: NOW, previousEngagement: 300, previousAt: hAgo(2) })).toBe(100);
  });
  it("falls back to lifetime when snapshots are too close or missing", () => {
    expect(velocityOf({ engagement: 500, publishedAt: hAgo(10), now: NOW, previousEngagement: 490, previousAt: hAgo(0.5) })).toBe(50);
    expect(velocityOf({ engagement: 500, publishedAt: hAgo(10), now: NOW })).toBe(50);
    // age is floored at 30 minutes
    expect(velocityOf({ engagement: 100, publishedAt: hAgo(0.1), now: NOW })).toBe(200);
    expect(velocityOf({ engagement: 100, publishedAt: null, now: NOW })).toBe(0);
  });
  it("never reports negative velocity when counters drop", () => {
    expect(velocityOf({ engagement: 100, publishedAt: hAgo(10), now: NOW, previousEngagement: 200, previousAt: hAgo(2) })).toBe(0);
  });
});

describe("computeHeat", () => {
  it("is a log scale of velocity times source weight", () => {
    const slow = computeHeat({ kind: "hn", points: 150, comments: 0, publishedAt: hAgo(10), now: NOW });
    const fast = computeHeat({ kind: "hn", points: 1500, comments: 0, publishedAt: hAgo(10), now: NOW });
    // 15/h * 15 = 225 → 25*log10(226) ≈ 59; 150/h → ≈ 84
    expect(slow.heat).toBe(59);
    expect(fast.heat).toBe(84);
    expect(fast.heat - slow.heat).toBeLessThan(30);
  });
  it("applies the floor and the per-source bar", () => {
    const young = computeHeat({ kind: "hn", points: 60, comments: 0, publishedAt: hAgo(0.5), now: NOW });
    expect(young.score).toBeGreaterThanOrEqual(1);
    expect(young.floorMet).toBe(false);
    expect(young.candidate).toBe(false);
    const ok = computeHeat({ kind: "hn", points: 400, comments: 0, publishedAt: hAgo(5), now: NOW });
    expect(ok.score).toBe(2);
    expect(ok.candidate).toBe(true);
  });
  it("decays with age and stops being a candidate after maxAgeHours", () => {
    const base = { kind: "hn" as const, points: 3000, comments: 0, now: NOW };
    const at20 = computeHeat({ ...base, publishedAt: hAgo(20), previous: { points: 2000, capturedAt: hAgo(2) } });
    const at30 = computeHeat({ ...base, publishedAt: hAgo(30), previous: { points: 2000, capturedAt: hAgo(2) } });
    const at40 = computeHeat({ ...base, publishedAt: hAgo(40), previous: { points: 2000, capturedAt: hAgo(2) } });
    expect(at20.velocity).toBe(500);
    expect(at20.heat).toBe(97);
    expect(at30.heat).toBe(82);
    expect(at40.fresh).toBe(false);
    expect(at40.candidate).toBe(false);
  });
  it("gives a small-account bonus and a mega-account penalty", () => {
    const common = { kind: "x_apify" as const, points: 5000, comments: 0, publishedAt: hAgo(5), now: NOW };
    const small = computeHeat({ ...common, followers: 200 });
    const none = computeHeat(common);
    const mega = computeHeat({ ...common, followers: 50_000_000 });
    // 1000/h → 75; 10 points per follower (floored at 500 followers) → +10.8; mega account clamps at -8
    expect(none.heat).toBe(75);
    expect(small.heat).toBe(86);
    expect(mega.heat).toBe(67);
  });
  it("scores feeds without counters on freshness and coverage", () => {
    const one = computeHeat({ kind: "rss", publishedAt: hAgo(2), now: NOW });
    const four = computeHeat({ kind: "google_news", publishedAt: hAgo(2), now: NOW, coverage: 4 });
    expect(one.heat).toBe(40);
    expect(one.candidate).toBe(true);
    expect(four.heat).toBe(64);
    expect(four.score).toBe(4);
    const stale = computeHeat({ kind: "rss", publishedAt: hAgo(60), now: NOW });
    expect(stale.candidate).toBe(false);
  });
  it("uses rank for ranked feeds without scores", () => {
    expect(computeHeat({ kind: "reddit", rank: 1, publishedAt: hAgo(2), now: NOW }).heat).toBe(74);
    expect(computeHeat({ kind: "reddit", rank: 20, publishedAt: hAgo(2), now: NOW }).heat).toBe(30);
    expect(computeHeat({ kind: "reddit", rank: 20, publishedAt: hAgo(2), now: NOW }).candidate).toBe(false);
  });
  it("lets GitHub repos stay hot for days", () => {
    const r = computeHeat({ kind: "github", points: 2400, publishedAt: hAgo(72), now: NOW });
    expect(r.fresh).toBe(true);
    expect(r.velocity).toBe(33.333);
    expect(r.candidate).toBe(true);
  });
  it("respects config overrides and source weight", () => {
    const strict = computeHeat({ kind: "hn", points: 400, comments: 0, publishedAt: hAgo(5), now: NOW, config: { hn: { bar: 200 } } });
    expect(strict.candidate).toBe(false);
    const boosted = computeHeat({ kind: "hn", points: 400, comments: 0, publishedAt: hAgo(5), now: NOW, sourceWeight: 2 });
    expect(boosted.score).toBe(4);
  });
  it("is bounded to 0–100", () => {
    const huge = computeHeat({ kind: "hn", points: 10_000_000, publishedAt: hAgo(1), now: NOW, followers: 1 });
    expect(huge.heat).toBe(100);
  });
});

describe("picks, caps and follow-ups", () => {
  const c = (id: string, heat: number, url = `https://example.com/${id}`) => ({ id, url, heat, score: 1 });
  it("caps per run and per day", () => {
    const cands = [c("a", 50), c("b", 90), c("c", 70)];
    expect(selectTrendPicks(cands, { alertedToday: 0 }).map((x) => x.id)).toEqual(["b"]);
    expect(selectTrendPicks(cands, { alertedToday: 0, perRun: 2 }).map((x) => x.id)).toEqual(["b", "c"]);
    expect(selectTrendPicks(cands, { alertedToday: 6 })).toEqual([]);
    expect(selectTrendPicks(cands, { alertedToday: 5, perRun: 3 }).map((x) => x.id)).toEqual(["b"]);
  });
  it("collapses candidates that share a canonical link", () => {
    const cands = [c("a", 90, "https://www.example.com/story?utm_source=x"), c("b", 80, "https://example.com/story/"), c("d", 70)];
    expect(selectTrendPicks(cands, { alertedToday: 0, perRun: 3 }).map((x) => x.id)).toEqual(["a", "d"]);
  });
  it("follows up once when velocity at least doubles", () => {
    expect(shouldFollowUp({ alertedVelocity: 100, velocity: 200, alreadyFollowedUp: false })).toBe(true);
    expect(shouldFollowUp({ alertedVelocity: 100, velocity: 199, alreadyFollowedUp: false })).toBe(false);
    expect(shouldFollowUp({ alertedVelocity: 100, velocity: 500, alreadyFollowedUp: true })).toBe(false);
    expect(shouldFollowUp({ alertedVelocity: null, velocity: 500, alreadyFollowedUp: false })).toBe(false);
    expect(shouldFollowUp({ alertedVelocity: 100, velocity: 300, alreadyFollowedUp: false, factor: 3 })).toBe(true);
  });
  it("labels velocity", () => {
    expect(velocityLabel(0.4)).toBe("under 1/h");
    expect(velocityLabel(42.4)).toBe("42/h");
    expect(velocityLabel(1234)).toBe("1.2k/h");
    expect(velocityLabel(12_345)).toBe("12k/h");
  });
});

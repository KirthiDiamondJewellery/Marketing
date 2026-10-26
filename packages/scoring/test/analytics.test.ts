import { describe, expect, it } from "vitest";
import {
  attributeFunnel, bandPosition, benchmarks, biggestDrop, change, collapseVariants, evidenceFor, featureAttribution, funnelSteps,
  goalPacing, interactions, linearFit, localMonth, localWeek, niceStep, pooledRate, postRates, rankDrivers, rollingBand, shrink,
  slotHeatmap, strengthOf, sumKnown, utmResolver, velocity, verdictOf, zonedMidnight, zonedParts,
} from "../src/index.ts";

describe("postRates", () => {
  const full = { views: 10_000, reach: 8_000, likes: 400, comments: 50, shares: 30, saves: 70, follows: 25, profileVisits: 120, clicks: 40, avgWatchS: 9, durationS: 30, skipRate: 0.42, completionRate: 0.18 };

  it("computes every rate from complete numbers", () => {
    const r = postRates(full);
    expect(r.engagementPerView).toBeCloseTo(550 / 10_000, 6);
    expect(r.engagementPerReach).toBeCloseTo(550 / 8_000, 6);
    expect(r.sendRate).toBeCloseTo(100 / 10_000, 6);
    expect(r.saveRate).toBeCloseTo(0.007, 6);
    expect(r.shareRate).toBeCloseTo(0.003, 6);
    expect(r.commentRate).toBeCloseTo(0.005, 6);
    expect(r.likeRate).toBeCloseTo(0.04, 6);
    expect(r.followsPer1k).toBe(2.5);
    expect(r.profileVisitRate).toBeCloseTo(0.012, 6);
    expect(r.clickRate).toBeCloseTo(0.004, 6);
    expect(r.watchPct).toBe(0.3);
    expect(r.holdRate).toBe(0.58);
    expect(r.completionRate).toBe(0.18);
  });

  it("treats missing numbers as unknown, never zero", () => {
    const r = postRates({ views: 1000 });
    expect(Object.values(r).every((v) => v === null)).toBe(true);
    expect(postRates({ likes: 10, comments: 2 }).engagementPerView).toBeNull(); // no views
    expect(postRates({ views: 0, likes: 10 }).engagementPerView).toBeNull(); // zero denominator
    expect(postRates({ views: 100, likes: 10 }).engagementPerView).toBe(0.1); // partial interactions
    expect(postRates({ views: 100, saves: 3 }).sendRate).toBe(0.03); // shares unknown
    expect(postRates({ views: 100, shares: 0, saves: 0 }).sendRate).toBe(0); // real zero stays zero
  });

  it("rejects impossible rates and negative counts", () => {
    expect(postRates({ skipRate: 1.4 }).holdRate).toBeNull();
    expect(postRates({ skipRate: -0.1 }).holdRate).toBeNull();
    expect(postRates({ completionRate: 2 }).completionRate).toBeNull();
    expect(postRates({ views: 100, likes: -5 }).likeRate).toBeNull();
    expect(postRates({ avgWatchS: 45, durationS: 30 }).watchPct).toBe(1.5); // rewatches exceed 1
    expect(postRates({ views: Number.NaN, likes: 3 }).likeRate).toBeNull();
  });

  it("sums known parts", () => {
    expect(sumKnown([1, null, 2, undefined])).toBe(3);
    expect(sumKnown([null, undefined])).toBeNull();
    expect(interactions({ likes: 1, comments: 2, shares: 3, saves: 4 })).toBe(10);
  });

  it("pools rates by summing numerators and denominators", () => {
    const p = pooledRate([{ num: 10, den: 1000 }, { num: 1, den: 10 }, { num: null, den: 50 }, { num: 5, den: 0 }]);
    expect(p.n).toBe(2);
    expect(p.value).toBeCloseTo(11 / 1010, 6);
    expect(pooledRate([], 1000)).toEqual({ value: null, n: 0 });
    expect(pooledRate([{ num: 3, den: 1000 }], 1000).value).toBe(3);
  });
});

describe("change and velocity", () => {
  it("handles zeros and missing values", () => {
    expect(change(150, 100)).toBe(0.5);
    expect(change(50, 100)).toBe(-0.5);
    expect(change(0, 0)).toBe(0);
    expect(change(5, 0)).toBeNull();
    expect(change(null, 3)).toBeNull();
    expect(change(-2, -4)).toBe(0.5);
  });
  it("compares early views with the early baseline", () => {
    expect(velocity(3000, 1000)).toBe(3);
    expect(velocity(0, 1000)).toBe(0);
    expect(velocity(500, 0)).toBeNull();
    expect(velocity(null, 1000)).toBeNull();
    expect(velocity(5, 0.5)).toBe(5); // divides by at least 1
  });
});

describe("rollingBand", () => {
  it("uses only earlier points and needs minN of them", () => {
    const band = rollingBand([10, 20, 30, 40, 50, 60, 1000], { window: 5, minN: 5 });
    expect(band.slice(0, 5).every((b) => b.median === null)).toBe(true);
    expect(band[5]).toEqual({ median: 30, low: 20, high: 40, n: 5 });
    expect(band[6]).toEqual({ median: 40, low: 30, high: 50, n: 5 }); // slides: 20..60
    expect(bandPosition(1000, band[6]!)).toBe("above");
    expect(bandPosition(35, band[6]!)).toBe("inside");
    expect(bandPosition(5, band[6]!)).toBe("below");
    expect(bandPosition(5, band[0]!)).toBeNull();
  });
  it("skips missing values without breaking positions", () => {
    const band = rollingBand([1, null, 2, 3], { minN: 2 });
    expect(band.map((b) => b.n)).toEqual([0, 1, 1, 2]);
    expect(band[3]!.median).toBe(1.5);
  });
});

describe("linearFit and drivers", () => {
  it("fits a perfect line", () => {
    const f = linearFit([1, 2, 3, 4], [3, 5, 7, 9])!;
    expect(f).toMatchObject({ n: 4, slope: 2, intercept: 1, r: 1, r2: 1, strength: "strong", direction: "up", small: true });
    expect(f.words).toBe("Strong positive link");
  });
  it("returns null without variance or with under 3 pairs", () => {
    expect(linearFit([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(linearFit([1, 2], [1, 2])).toBeNull();
    expect(linearFit([1, null, 3, 4], [2, 5, null, 8])).toBeNull(); // only 2 complete pairs
  });
  it("labels strength bands", () => {
    expect([0.1, 0.3, 0.5, 0.9, -0.95].map(strengthOf)).toEqual(["none", "weak", "moderate", "strong", "strong"]);
    const neg = linearFit([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])!;
    expect(neg.words).toBe("Strong negative link");
  });
  it("ranks drivers by |r| and skips excluded or thin ones", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ y: i, a: i * 2, b: (i % 3) - 1, c: 12 - i, d: i < 3 ? i : null }));
    const d = rankDrivers(rows, (r) => r.y, { a: (r) => r.a, b: (r) => r.b, c: (r) => r.c, d: (r) => r.d }, { exclude: ["c"] });
    expect(d.map((x) => x.key)).toEqual(["a", "b"]);
    expect(d[0]!.fit.small).toBe(false);
  });
  it("picks nice steps", () => {
    expect(niceStep(100)).toBe(20);
    expect(niceStep(7)).toBe(1);
    expect(niceStep(0.3)).toBeCloseTo(0.05, 10);
    expect(niceStep(0)).toBe(1);
  });
});

describe("slotHeatmap", () => {
  // 2026-10-12 is a Monday.
  const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, 12 + day, hour, 0));

  it("buckets by local weekday (Monday first) and time block", () => {
    const h = slotHeatmap([{ publishedAt: at(0, 9), x: 2 }, { publishedAt: at(6, 23), x: 1 }], { timeZone: "UTC", blockHours: 3, minN: 1, priorN: 0 });
    expect(h.cells).toHaveLength(56);
    const mon = h.cells.find((c) => c.day === 0 && c.block === 3)!;
    expect(mon).toMatchObject({ startHour: 9, endHour: 12, n: 1, medianX: 2, shrunkX: 2 });
    expect(h.cells.find((c) => c.day === 6 && c.block === 7)!.n).toBe(1);
  });

  it("respects the time zone", () => {
    // 03:00 UTC Monday is 22:00 Sunday in Chicago.
    const h = slotHeatmap([{ publishedAt: at(0, 3), x: 1 }], { timeZone: "America/Chicago", minN: 1 });
    expect(h.cells.find((c) => c.n === 1)).toMatchObject({ day: 6, block: 7 });
  });

  it("shrinks small cells toward the overall median and only ranks cells with enough posts", () => {
    const rows = [
      ...[3, 3.2, 2.8].map((x) => ({ publishedAt: at(1, 18), x })), // Tue evening, n=3, median 3
      { publishedAt: at(2, 9), x: 9 }, // Wed morning, a lucky single
      ...[1, 1, 1, 1, 1].map((x, i) => ({ publishedAt: at(3, 12 + (i % 2)), x })),
    ];
    const h = slotHeatmap(rows, { timeZone: "UTC", minN: 3, priorN: 3 });
    expect(h.overallMedian).toBe(1);
    const lucky = h.cells.find((c) => c.day === 2 && c.block === 3)!;
    expect(lucky.medianX).toBe(9);
    expect(lucky.shrunkX).toBe(3); // (1·9 + 3·1) / 4
    expect(lucky.evidence).toBe("low");
    expect(h.best.map((c) => [c.day, c.block])).toEqual([[1, 6], [3, 4]]);
    expect(h.best[0]!.shrunkX).toBe(2); // (3·3 + 3·1) / 6
    expect(h.best[0]!.ciLow).not.toBeNull();
    expect(h.byDay[1]).toMatchObject({ label: "Tue", n: 3 });
    expect(h.gaps.some((g) => g.includes("Mon, Fri, Sat, Sun"))).toBe(true);
  });

  it("reports gaps instead of guessing", () => {
    expect(slotHeatmap([]).gaps[0]).toMatch(/^GAP: no measured posts/);
    const thin = slotHeatmap([{ publishedAt: at(0, 9), x: 1 }, { publishedAt: at(1, 9), x: null }], { minN: 3 });
    expect(thin.n).toBe(1);
    expect(thin.best).toEqual([]);
    expect(thin.gaps[0]).toMatch(/no time slot has 3 posts/);
  });

  it("evidence and shrink helpers", () => {
    expect([0, 1, 3, 5, 6].map((n) => evidenceFor(n, 3))).toEqual(["none", "low", "medium", "medium", "high"]);
    expect(shrink(null, 0, 1, 3)).toBeNull();
    expect(shrink(2, 2, null, 3)).toBe(2);
    expect(shrink(2, 1, 1, 0)).toBe(2);
  });
});

describe("goalPacing", () => {
  const start = new Date("2026-10-12T05:00:00Z");
  const end = new Date("2026-10-19T05:00:00Z");
  const mid = new Date("2026-10-15T17:00:00Z"); // half way

  it("projects count goals from the run rate", () => {
    const p = goalPacing({ target: 10, kind: "sum", periodStart: start, periodEnd: end, now: mid, actual: 6 });
    expect(p.elapsed).toBe(0.5);
    expect(p.expectedByNow).toBe(5);
    expect(p.projected).toBe(12);
    expect(p.status).toBe("on_track");
    expect(p.requiredPerDay).toBeCloseTo(4 / 3.5, 3);
  });

  it("flags at-risk and behind", () => {
    expect(goalPacing({ target: 10, kind: "sum", periodStart: start, periodEnd: end, now: mid, actual: 4.5 }).status).toBe("at_risk"); // projects 9
    const behind = goalPacing({ target: 10, kind: "sum", periodStart: start, periodEnd: end, now: mid, actual: 2 });
    expect(behind.status).toBe("behind");
    expect(behind.line).toMatch(/Needs .* a day/);
  });

  it("leans on the trailing rate early in the period", () => {
    const early = new Date(start.getTime() + 0.1 * 7 * 86_400_000);
    const p = goalPacing({ target: 10, kind: "sum", periodStart: start, periodEnd: end, now: early, actual: 0, trailingDailyRate: 2 });
    expect(p.projected).toBeCloseTo(0.9 * 2 * 6.3, 1); // 90% trailing weight × 2/day × 6.3 days left
    expect(p.status).toBe("on_track");
    const noTrail = goalPacing({ target: 10, kind: "sum", periodStart: start, periodEnd: end, now: early, actual: 0 });
    expect(noTrail.status).toBe("behind");
  });

  it("marks met goals and handles lower-is-better averages", () => {
    expect(goalPacing({ target: 5, kind: "sum", periodStart: start, periodEnd: end, now: mid, actual: 5 }).status).toBe("met");
    const skip = goalPacing({ target: 0.4, kind: "average", direction: "down", periodStart: start, periodEnd: end, now: mid, actual: 0.45 });
    expect(skip.status).toBe("at_risk"); // 0.4 / 0.45 = 0.89
    expect(skip.paceRatio).toBeCloseTo(0.889, 3);
    expect(goalPacing({ target: 0.4, kind: "average", direction: "down", periodStart: start, periodEnd: end, now: mid, actual: 0.38 }).status).toBe("met");
    expect(goalPacing({ target: 3, kind: "average", periodStart: start, periodEnd: end, now: mid, actual: 1 }).status).toBe("behind");
  });

  it("is honest without data or target", () => {
    expect(goalPacing({ target: 5, kind: "sum", periodStart: start, periodEnd: end, now: mid, actual: null }).status).toBe("no_data");
    const nt = goalPacing({ target: null, kind: "sum", periodStart: start, periodEnd: end, now: mid, actual: 3 });
    expect(nt.status).toBe("no_target");
    expect(nt.projected).toBe(6);
  });

  it("clamps elapsed outside the period", () => {
    const after = goalPacing({ target: 10, kind: "sum", periodStart: start, periodEnd: end, now: new Date("2026-10-30T00:00:00Z"), actual: 3 });
    expect(after.elapsed).toBe(1);
    expect(after.daysLeft).toBe(0);
    expect(after.projected).toBe(3);
    expect(after.requiredPerDay).toBeNull();
  });
});

describe("local calendar periods", () => {
  it("finds the local Monday-to-Monday week", () => {
    const w = localWeek(new Date("2026-10-15T17:00:00Z"), "America/Chicago");
    expect(w.start.toISOString()).toBe("2026-10-12T05:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-19T05:00:00.000Z");
    // Late Sunday night local is still the same week.
    expect(localWeek(new Date("2026-10-19T04:30:00Z"), "America/Chicago").start.toISOString()).toBe("2026-10-12T05:00:00.000Z");
  });
  it("survives a DST change and month boundaries", () => {
    const w = localWeek(new Date("2026-11-03T12:00:00Z"), "America/Chicago"); // DST ends Nov 1
    expect(w.start.toISOString()).toBe("2026-11-02T06:00:00.000Z");
    const m = localMonth(new Date("2026-12-20T12:00:00Z"), "UTC");
    expect(m.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(m.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(zonedParts(zonedMidnight(2026, 3, 8, "America/New_York"), "America/New_York")).toMatchObject({ day: 8, hour: 0, minute: 0 });
  });
});

describe("funnel attribution", () => {
  const posts = [
    { postId: "ig42", platform: "instagram", utmContent: "notebook_42", publishedAt: "2026-10-01T00:00:00Z" },
    { postId: "tt42", platform: "tiktok", utmContent: "notebook_42", publishedAt: "2026-10-01T01:00:00Z" },
    { postId: "ig43", platform: "instagram", utmContent: "ink_43", publishedAt: "2026-10-03T00:00:00Z" },
  ];

  it("resolves tags by exact match, platform, then post number", () => {
    const r = utmResolver(posts);
    expect(r("notebook_42")).toBe("ig42");
    expect(r("NOTEBOOK_42", "tiktok")).toBe("tt42");
    expect(r("notebook_42", "youtube")).toBe("ig42");
    expect(r("renamed_43")).toBe("ig43");
    expect(r("nothing")).toBeNull();
    expect(r(null)).toBeNull();
  });

  it("credits outcomes to the visitor's first touch, dedupes leads by email and sums revenue", () => {
    const a = attributeFunnel(
      [
        { kind: "click", at: "2026-10-05T10:00:00Z", utmContent: "notebook_42", utmSource: "tiktok", visitorId: "v1" },
        { kind: "click", at: "2026-10-06T10:00:00Z", utmContent: "ink_43", visitorId: "v1" },
        { kind: "lead", at: "2026-10-06T10:05:00Z", visitorId: "v1", email: "A@example.com" },
        { kind: "lead", at: "2026-10-07T10:05:00Z", utmContent: "ink_43", email: "a@example.com" }, // same person
        { kind: "booking", at: "2026-10-08T10:00:00Z", visitorId: "v1" },
        { kind: "sale", at: "2026-10-09T10:00:00Z", visitorId: "v1", valueUsd: 1200 },
        { kind: "sale", at: "2026-10-09T11:00:00Z", utmContent: "ink_43", valueUsd: 300.5 },
        { kind: "lead", at: "2026-10-09T12:00:00Z", email: "b@example.com" },
        { kind: "click", at: "2026-10-09T12:00:00Z", utmContent: "unknown_tag" },
      ],
      posts,
    );
    expect(a.byPost.get("tt42")).toEqual({ clicks: 2, leads: 1, bookings: 1, sales: 1, revenue: 1200 });
    expect(a.byPost.get("ig43")).toEqual({ clicks: 0, leads: 0, bookings: 0, sales: 1, revenue: 300.5 });
    expect(a.untagged).toEqual({ clicks: 0, leads: 1, bookings: 0, sales: 0, revenue: 0 });
    expect(a.unmatched.get("unknown_tag")!.clicks).toBe(1);
    expect(a.totals).toEqual({ clicks: 3, leads: 2, bookings: 1, sales: 2, revenue: 1500.5 });
  });

  it("builds steps with conversion and finds the biggest drop", () => {
    const steps = funnelSteps([
      { key: "views", label: "Views", value: 10_000 },
      { key: "clicks", label: "Clicks", value: 200 },
      { key: "leads", label: "Leads", value: 40 },
      { key: "bookings", label: "Bookings", value: 0 },
      { key: "revenue", label: "Sales", value: null },
    ]);
    expect(steps[1]).toMatchObject({ fromPrevious: 0.02, fromTop: 0.02 });
    expect(steps[2]!.fromPrevious).toBe(0.2);
    expect(steps[3]!.fromPrevious).toBe(0);
    expect(steps[4]!.fromPrevious).toBeNull();
    expect(biggestDrop(steps)!.key).toBe("bookings");
    expect(funnelSteps([{ key: "a", label: "A", value: 0 }])[0]!.fromTop).toBeNull();
  });
});

describe("benchmarks", () => {
  const mk = (views: number[], x?: number[]) => views.map((v, i) => ({ views: v, likes: v * 0.05, comments: v * 0.01, x: x?.[i] ?? null }));

  it("compares the account's medians with tracked creators", () => {
    const b = benchmarks(mk([1000, 2000, 3000, 4000, 5000], [0.5, 1, 1, 2.5, 3]), [
      { key: "a", label: "@a", posts: mk([10_000, 12_000, 14_000, 16_000, 18_000], [1, 1, 1, 1, 4]) },
      { key: "b", label: "@b", posts: mk([1000, 1500, 2000, 2500, 2800], [1, 1, 1, 1, 1]) },
      { key: "c", label: "@c", posts: mk([500, 600]) },
    ]);
    expect(b.own).toMatchObject({ medianViews: 3000, outlierShare: 0.4, bestX: 3, n: 5 });
    expect(b.own.medianEngagement).toBeCloseTo(0.06, 5);
    expect(b.peers.map((p) => p.key)).toEqual(["a", "b", "c"]);
    expect(b.peerMedianViews).toBe(8000); // median of 14000 and 2000; @c is too thin
    expect(b.viewsRatio).toBe(0.375);
    expect(b.viewsPercentile).toBe(0.5);
    expect(b.peerOutlierShare).toBe(0.1);
    expect(b.gaps[0]).toMatch(/@c has fewer than 5/);
  });

  it("reports gaps with no peers", () => {
    const b = benchmarks(mk([1, 2]), []);
    expect(b.peerMedianViews).toBeNull();
    expect(b.viewsRatio).toBeNull();
    expect(b.gaps).toHaveLength(2);
  });
});

describe("collapseVariants", () => {
  it("keeps the best variant whole and counts the group", () => {
    const rows = [
      { id: "a", g: "1", views: 100, likes: 9 },
      { id: "b", g: "1", views: 900, likes: 3 },
      { id: "c", g: "2", views: null, likes: 1 },
      { id: "d", g: "2", views: 50, likes: 0 },
      { id: "e", g: "3", views: null, likes: 0 },
    ];
    const out = collapseVariants(rows, (r) => r.g, (r) => r.views);
    expect(out.map((o) => [o.row.id, o.variants])).toEqual([["b", 2], ["d", 2], ["e", 1]]);
    expect(out[0]!.row.likes).toBe(3); // numbers are never mixed across variants
  });
});

describe("attribution verdicts", () => {
  it("labels clear wins, leanings and gaps", () => {
    const rows = [
      ...[3, 3.1, 3.2, 2.9, 3.3, 3, 3.1].map((x) => ({ x, features: { lane: "proof" } })),
      ...[1, 0.9, 1.1, 1, 0.95, 1.05, 1].map((x) => ({ x, features: { lane: "myth" } })),
      ...[1.4, 0.3, 2.5, 0.9, 1.6].map((x) => ({ x, features: { lane: "mixed" } })),
      { x: 5, features: { lane: "new" } },
    ];
    const r = featureAttribution(rows, { minN: 5, dimensions: ["lane"] });
    const by = Object.fromEntries(r.stats.map((s) => [s.value, s]));
    expect(by.proof!.verdict).toBe("clear_win");
    expect(by.proof!.liftLow).not.toBeNull();
    expect(by.myth!.verdict).toBe("clear_loss");
    expect(by.mixed!.verdict).toBe("flat");
    expect(by.new!.verdict).toBe("gap");
    expect(verdictOf({ sufficient: true, clear: false, lift: 1.3, ciLow: 0.8 }, 1)).toBe("leaning_up");
    expect(verdictOf({ sufficient: true, clear: false, lift: 0.7, ciLow: 0.4 }, 1)).toBe("leaning_down");
  });

  it("formats other metrics in report lines", () => {
    const r = featureAttribution(
      [0.01, 0.012, 0.011, 0.009, 0.013].map((x) => ({ x, features: { format: "list" } })),
      { minN: 5, dimensions: ["format"], metricLabel: "send rate", format: (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`) },
    );
    expect(r.stats[0]!.line).toMatch(/median send rate 1\.1% \(lift 1x, n=5, 90% range 0\.9%–1\.3%\)/);
  });
});

import { describe, expect, it } from "vitest";
import { parseConfig } from "@attentionos/core";
import { busiest24h, cleanHashtags, fitUnderCap, foreignTitleWords, hashtagsIn, interleave, slots, slugFor, splitTotal, zonedToUtc } from "../src/plan.ts";
import { postingPlan } from "../src/repo.ts";
import { graduationStrategy, trialReelsSettings, trialReelsSettingsSchema } from "../src/settings.ts";

const TZ = "America/Chicago";
const local = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);

describe("settings", () => {
  it("defaults to 9 a day, 08:00 to 21:00, manual graduation, the 50/24h cap", () => {
    const s = trialReelsSettingsSchema.parse({});
    expect(s).toMatchObject({ dailyTotal: 9, dailyCap: 50, window: { start: "08:00", end: "21:00" }, graduation: "manual" });
    expect(s.speeds).toHaveLength(8);
    expect(graduationStrategy(s)).toBe("MANUAL");
    expect(graduationStrategy({ ...s, graduation: "auto" })).toBe("SS_PERFORMANCE");
  });

  it("refuses unsafe values", () => {
    const bad = (settings: unknown) => trialReelsSettingsSchema.safeParse(settings).success;
    expect(bad({ dailyTotal: 51 })).toBe(false);
    expect(bad({ speeds: [1.05, 1.2] })).toBe(false); // over 1.1x
    expect(bad({ speeds: [1.02, 1.04, 1.05, 1.06, 1.08] })).toBe(false); // 5 speeds would repeat looks
    expect(bad({ speeds: [1.02, 1.02, 1.04] })).toBe(false);
    expect(bad({ window: { start: "21:00", end: "08:00" } })).toBe(false);
    expect(bad({ hashtagSets: { kitchens: ["a", "b"] } })).toBe(false);
    expect(bad({ hashtagSets: { kitchens: ["#kitchen", "remodel", "homereno", "interiors", "cabinets"] } })).toBe(true);
  });

  it("reads modules.trial-reels.settings from the workspace config", () => {
    const config = parseConfig({ modules: { "trial-reels": { settings: { dailyTotal: 12, graduation: "auto" } } } });
    expect(trialReelsSettings(config)).toMatchObject({ dailyTotal: 12, graduation: "auto" });
    expect(() => trialReelsSettings(parseConfig({ modules: { "trial-reels": { settings: { dailyTotal: 99 } } } }))).toThrow(/dailyTotal/);
  });
});

describe("slots and order", () => {
  it("spreads 9 posts evenly from 08:00 to 21:00 in the workspace timezone", () => {
    const s = slots("2026-10-15", 9, { start: "08:00", end: "21:00" }, TZ);
    expect(s.map(local)).toEqual(["08:00", "09:38", "11:15", "12:53", "14:30", "16:08", "17:45", "19:23", "21:00"]);
    expect(s[0]!.toISOString()).toBe("2026-10-15T13:00:00.000Z"); // CDT
    expect(slots("2026-12-03", 1, { start: "08:00", end: "21:00" }, TZ)[0]!.toISOString()).toBe("2026-12-03T14:00:00.000Z"); // CST
    expect(zonedToUtc("2026-03-08", "08:00", "America/New_York").toISOString()).toBe("2026-03-08T12:00:00.000Z"); // DST day
  });

  it("takes turns between reels so a video never posts twice in a row", () => {
    const v = [...Array.from({ length: 5 }, (_, i) => ({ reel: "a", i })), ...Array.from({ length: 4 }, (_, i) => ({ reel: "b", i }))];
    const order = interleave(v);
    expect(order.map((x) => x.reel).join("")).toBe("ababababa");
    expect(order.every((x, i) => i === 0 || x.reel !== order[i - 1]!.reel)).toBe(true);
    expect(interleave([])).toEqual([]);
  });

  it("builds the posting plan, leaving out the proof post", () => {
    const variants = ["a-01", "a-02", "b-01", "b-02"].map((id) => ({ id, reel: id.slice(0, 1), title: id, postCaption: `#${id}` }));
    const batch = { post_date: "2026-10-15", manifest: { variants } } as never;
    const plan = postingPlan(batch, { window: { start: "08:00", end: "20:00" }, timezone: TZ });
    expect(plan.map((p) => p.variantId)).toEqual(["a-01", "b-01", "a-02", "b-02"]);
    expect(plan.map((p) => local(p.at!))).toEqual(["08:00", "12:00", "16:00", "20:00"]);
    const rest = postingPlan(batch, { window: { start: "08:00", end: "20:00" }, timezone: TZ, postedNow: new Set(["a-01"]) });
    expect(rest.map((p) => p.variantId)).toEqual(["a-02", "b-01", "b-02"]);
  });
});

describe("the 24-hour cap", () => {
  const day = (n: number) => slots("2026-10-15", n, { start: "08:00", end: "21:00" }, TZ);
  it("counts the busiest 24 hours", () => {
    const t = (h: number) => new Date(Date.UTC(2026, 9, 15, h));
    expect(busiest24h([t(0), t(10), t(23), t(24), t(30)])).toBe(4);
    expect(busiest24h([])).toBe(0);
  });
  it("fits the day under the cap, counting the account's other posts", () => {
    expect(fitUnderCap({ wanted: 9, existing: [], cap: 50, slotsFor: day })).toBe(9);
    // 45 posts the evening before (19:00–19:44 local): 6 spread over the day keep every 24 hours at 50 (the last one,
    // at 21:00, is more than 24 hours after them).
    const other = Array.from({ length: 45 }, (_, i) => new Date(Date.UTC(2026, 9, 15, 0, i)));
    expect(fitUnderCap({ wanted: 9, existing: other, cap: 50, slotsFor: day })).toBe(6);
    expect(busiest24h([...other, ...day(6)])).toBe(50);
    expect(fitUnderCap({ wanted: 9, existing: Array(50).fill(new Date(Date.UTC(2026, 9, 15, 15))), cap: 50, slotsFor: day })).toBe(0);
  });
});

describe("the owner's words", () => {
  it("allows only reorders of the owner's title (plus small connecting words)", () => {
    expect(foreignTitleWords("Three tile mistakes to avoid", "Avoid these three tile mistakes")).toEqual(["these"]);
    expect(foreignTitleWords("Three tile mistakes to avoid", "Tile mistakes: avoid the three")).toEqual([]);
    expect(foreignTitleWords("Three tile mistakes to avoid", "TILE MISTAKES TO AVOID")).toEqual([]);
    expect(foreignTitleWords("Three tile mistakes", "Secret contractor hack")).toEqual(["secret", "contractor", "hack"]);
  });

  it("cleans hashtags", () => {
    expect(cleanHashtags(["#kitchen", "kitchen", "Kitchen remodel", "##reno", "bad-tag", ""])).toEqual(["kitchen", "remodel", "reno"]);
    expect(hashtagsIn("Done once, done right.\n\n#kitchenremodel #homereno")).toEqual(["kitchenremodel", "homereno"]);
  });

  it("makes short unique slugs and splits the total like media-py", () => {
    const taken = new Set(["mudroom-garage"]);
    expect(slugFor("The mudroom garage entry", taken)).toBe("mudroom-garage-entry");
    expect(slugFor("Mudroom: garage", taken)).toBe("mudroom-garage-2");
    expect(slugFor("🔥🔥", new Set())).toBe("reel");
    expect(splitTotal(9, 2)).toEqual([5, 4]);
    expect(splitTotal(40, 3)).toEqual([14, 13, 13]);
  });
});

import { describe, expect, it } from "vitest";
import { CronError, isValidCron, latestFire, nextFire, parseCron } from "../src/index.ts";

describe("cron", () => {
  it("evaluates schedules in the workspace timezone", () => {
    // 7:00 in Chicago (CDT, UTC-5) on 2026-10-10 is 12:00Z.
    expect(nextFire("0 7 * * *", "America/Chicago", new Date("2026-10-10T00:00:00Z"))?.toISOString()).toBe("2026-10-10T12:00:00.000Z");
    expect(nextFire("0 7 * * *", "UTC", new Date("2026-10-10T00:00:00Z"))?.toISOString()).toBe("2026-10-10T07:00:00.000Z");
    // After the DST change (CST, UTC-6) the same local time is 13:00Z.
    expect(nextFire("0 7 * * *", "America/Chicago", new Date("2026-11-10T00:00:00Z"))?.toISOString()).toBe("2026-11-10T13:00:00.000Z");
  });

  it("supports weekday ranges, steps and nicknames", () => {
    // 2026-10-10 is a Saturday: the next weekday 7:00 is Monday the 12th.
    expect(nextFire("0 7 * * 1-5", "UTC", new Date("2026-10-10T08:00:00Z"))?.toISOString()).toBe("2026-10-12T07:00:00.000Z");
    expect(nextFire("*/15 * * * *", "UTC", new Date("2026-10-10T08:01:00Z"))?.toISOString()).toBe("2026-10-10T08:15:00.000Z");
    expect(nextFire("@daily", "UTC", new Date("2026-10-10T08:00:00Z"))?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });

  it("returns only the most recent fire in a window", () => {
    const since = new Date("2026-10-10T08:00:00Z");
    expect(latestFire("*/15 * * * *", "UTC", since, new Date("2026-10-10T08:50:00Z"))?.toISOString()).toBe("2026-10-10T08:45:00.000Z");
    expect(latestFire("0 9 * * *", "UTC", since, new Date("2026-10-10T08:50:00Z"))).toBeNull();
    // The window is (since, until]: a fire exactly at `since` already ran.
    expect(latestFire("0 8 * * *", "UTC", since, new Date("2026-10-10T08:10:00Z"))).toBeNull();
  });

  it("rejects invalid expressions with a plain message", () => {
    expect(() => parseCron("0 0 7 * * *", "UTC")).toThrow(CronError);
    expect(() => parseCron("0 7 * *", "UTC")).toThrow(/5 fields/);
    expect(() => parseCron("61 7 * * *", "UTC")).toThrow(/isn't a valid schedule/);
    expect(isValidCron("0 7 * * 1-5")).toBe(true);
    expect(isValidCron("whenever")).toBe(false);
  });
});

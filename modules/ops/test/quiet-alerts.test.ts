import { describe, expect, it } from "vitest";
import { alertDecision, alertKey, alertText } from "../src/lib/alerts.ts";
import { isQuietHours, mayDeliver, parseQuietInput, quietUntil } from "../src/lib/quiet-hours.ts";
import { localDayBounds } from "../src/lib/time.ts";

const CHI = "America/Chicago"; // UTC-5 in October (CDT)
const at = (iso: string) => new Date(iso);

describe("quiet hours", () => {
  const overnight = { start: "21:30", end: "07:00" };

  it("handles windows that wrap past midnight, in the workspace time zone", () => {
    expect(isQuietHours(at("2026-10-14T03:00:00Z"), CHI, overnight)).toBe(true); // 22:00 local
    expect(isQuietHours(at("2026-10-14T11:59:00Z"), CHI, overnight)).toBe(true); // 06:59 local
    expect(isQuietHours(at("2026-10-14T12:00:00Z"), CHI, overnight)).toBe(false); // 07:00 local
    expect(isQuietHours(at("2026-10-14T02:29:00Z"), CHI, overnight)).toBe(false); // 21:29 local
  });

  it("handles same-day windows and no window", () => {
    const lunch = { start: "12:00", end: "13:00" };
    expect(isQuietHours(at("2026-10-14T17:30:00Z"), CHI, lunch)).toBe(true);
    expect(isQuietHours(at("2026-10-14T18:00:00Z"), CHI, lunch)).toBe(false);
    expect(isQuietHours(at("2026-10-14T03:00:00Z"), CHI, null)).toBe(false);
    expect(isQuietHours(at("2026-10-14T03:00:00Z"), CHI, { start: "08:00", end: "08:00" })).toBe(false);
  });

  it("holds normal messages but lets high priority through", () => {
    const night = at("2026-10-14T03:00:00Z");
    expect(mayDeliver("normal", night, CHI, overnight)).toBe(false);
    expect(mayDeliver(undefined, night, CHI, overnight)).toBe(false);
    expect(mayDeliver("high", night, CHI, overnight)).toBe(true);
    expect(mayDeliver("low", at("2026-10-14T15:00:00Z"), CHI, overnight)).toBe(true);
  });

  it("says when the window ends", () => {
    expect(quietUntil(at("2026-10-14T03:00:00Z"), CHI, overnight)?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(quietUntil(at("2026-10-14T15:00:00Z"), CHI, overnight)).toBeNull();
  });

  it("parses friendly input", () => {
    expect(parseQuietInput("22:00 - 6:30")).toEqual({ start: "22:00", end: "06:30" });
    expect(parseQuietInput("10pm until 6am")).toEqual({ start: "22:00", end: "06:00" });
    expect(parseQuietInput("off")).toBeNull();
    expect(() => parseQuietInput("25:00-07:00")).toThrow();
  });

  it("computes local day bounds across time zones", () => {
    const d = localDayBounds(at("2026-10-14T03:00:00Z"), CHI);
    expect(d).toEqual({ date: "2026-10-13", start: at("2026-10-13T05:00:00Z"), end: at("2026-10-14T05:00:00Z") });
    // DST ends on 2026-11-01 in the US: that local day is 25 hours long.
    const dst = localDayBounds(at("2026-11-01T12:00:00Z"), CHI);
    expect((dst.end.getTime() - dst.start.getTime()) / 3_600_000).toBe(25);
  });
});

describe("alert dedupe", () => {
  const hour = 3_600_000;
  const t0 = at("2026-10-13T12:00:00Z");

  it("sends the first alert", () => {
    expect(alertDecision(null, t0, 3 * hour)).toEqual({ send: true, suppressed: 0, next: { lastSentAt: t0, count: 1 } });
  });

  it("counts repeats inside the window without sending", () => {
    const d = alertDecision({ lastSentAt: t0, count: 1 }, at("2026-10-13T13:00:00Z"), 3 * hour);
    expect(d).toEqual({ send: false, suppressed: 1, next: { lastSentAt: t0, count: 2 } });
  });

  it("sends again after the window and reports what was held back", () => {
    const later = at("2026-10-13T15:00:00Z");
    const d = alertDecision({ lastSentAt: t0, count: 4 }, later, 3 * hour);
    expect(d).toEqual({ send: true, suppressed: 3, next: { lastSentAt: later, count: 1 } });
    expect(alertText("Instagram disconnected.", 3)).toBe("Instagram disconnected.\n_This happened 3 more times since the last alert._");
    expect(alertText("x", 0)).toBe("x");
  });

  it("normalizes keys", () => {
    expect(alertKey("Account Expired", "Instagram")).toBe("account-expired:instagram");
  });
});

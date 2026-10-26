import { describe, expect, it } from "vitest";
import { compactNumber, composeBrief, composeSessionSummary, formatX, type BriefData } from "../src/lib/brief.ts";

const base: BriefData = {
  date: "2026-10-13",
  dayLabel: "Tue, Oct 13",
  filmToday: [],
  approvals: { total: 0, items: [] },
  scheduledToday: [],
  yesterday: { published: [], leads: 0, hotConversations: 0 },
  breakout: null,
  alerts: [],
  spend: null,
};

describe("deterministic brief composer", () => {
  it("renders a quiet day with only the results section", () => {
    const b = composeBrief(base);
    expect(b.title).toBe("Morning brief, Tue, Oct 13");
    expect(b.sections.map((s) => s.name)).toEqual(["Results"]);
    expect(b.text).toBe("Morning brief, Tue, Oct 13\n\nResults\n- Nothing published yesterday");
  });

  it("renders every section in order with exact numbers", () => {
    const b = composeBrief({
      ...base,
      filmToday: [
        { title: "3 permit mistakes", lane: "Myth bust", status: "scripted", keyword: "PERMIT", filmBy: "today 4:00 PM" },
        { title: "Kitchen budget teardown", header: "Where $40k actually goes", lane: "Proof", status: "idea", filmBy: "Mon, Oct 12 5:00 PM", overdue: true },
      ],
      approvals: {
        total: 7,
        items: [
          { ref: "ap-3", kind: "script", agent: "Copywriter", summary: "Script: 3 permit mistakes" },
          { ref: "ap-4", kind: "post", agent: "Publisher", summary: "4 posts for next week" },
        ],
      },
      scheduledToday: [
        { title: "Contractor red flags", platform: "tiktok", at: "11:00 AM" },
        { title: "Contractor red flags", platform: "instagram", at: "6:00 PM", assist: true },
      ],
      yesterday: { published: [{ title: "Tile choices", platform: "instagram", views: 18450, xScore: 2.43 }], leads: 3, hotConversations: 1 },
      breakout: { title: "Tile choices", platform: "instagram", views: 18450, xScore: 2.43 },
      alerts: [{ level: "danger", text: "instagram account @examplebrand.studio is disconnected. Reconnect it to keep publishing." }],
      spend: { todayUsd: 4.5, dailyBudgetUsd: 5 },
    }, { maxApprovals: 2 });

    expect(b.sections.map((s) => s.name)).toEqual(["Film today", "Waiting for you (7)", "Going out today", "Results", "Heads up"]);
    expect(b.sections[0]!.lines).toEqual([
      "3 permit mistakes (Myth bust · keyword PERMIT · film by today 4:00 PM)",
      'Kitchen budget teardown: "Where $40k actually goes" (Proof · overdue, was due Mon, Oct 12 5:00 PM)',
    ]);
    expect(b.sections[1]!.lines.at(-1)).toBe('and 5 more. Reply "approvals" to see them all.');
    expect(b.sections[2]!.lines[1]).toContain("Post this one yourself");
    expect(b.sections[3]!.lines).toEqual([
      "Tile choices on Instagram: 18k views, 2.4× your usual",
      "3 new leads, 1 hot conversation waiting for a reply",
      "Best this week: Tile choices on Instagram: 18k views, 2.4× your usual",
    ]);
    expect(b.sections[4]!.lines[1]).toBe("AI spend today is $4.50 of your $5.00 daily budget");
    expect(b.markdown.startsWith("*Morning brief, Tue, Oct 13*\n\n*Film today*\n• 3 permit mistakes")).toBe(true);
  });

  it("applies the demo-mode mask to names but leaves numbers alone", () => {
    const b = composeBrief(
      { ...base, approvals: { total: 1, items: [{ ref: "ap-9", kind: "dm_reply", agent: "Community", summary: "Reply to Pat Example about a $12,000 quote" }] } },
      { mask: (s) => s.replace("Pat Example", "Avery Holt") },
    );
    expect(b.sections[0]!.lines[0]).toBe("ap-9 · Community: Reply to Avery Holt about a $12,000 quote");
  });

  it("formats numbers compactly", () => {
    expect([compactNumber(950), compactNumber(1234), compactNumber(18450), compactNumber(2_340_000)]).toEqual(["950", "1.2k", "18k", "2.3M"]);
    expect([formatX(2.43), formatX(0.55), formatX(3)]).toEqual(["2.4×", "0.6×", "3×"]);
  });

  it("writes the session-start summary", () => {
    expect(composeSessionSummary(base)).toBe("AttentionOS: nothing is waiting for your approval.");
    const s = composeSessionSummary({
      approvals: { total: 1, items: [{ ref: "ap-3", kind: "script", agent: "Copywriter", summary: "Script: 3 permit mistakes" }] },
      filmToday: [{ title: "x", status: "idea" }],
      alerts: [],
    });
    expect(s).toBe(
      "AttentionOS: 1 approval waiting.\n  ap-3 · Copywriter: Script: 3 permit mistakes\nRun /attention:approvals to review them.\n1 piece to film today. Run /attention:brief for details.",
    );
  });
});

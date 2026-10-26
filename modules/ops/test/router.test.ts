import { describe, expect, it } from "vitest";
import { normalizeApprovalRef, parseActionId, parseRef } from "../src/lib/refs.ts";
import { routeInbound } from "../src/lib/router.ts";

const text = (t: string, extra: Record<string, unknown> = {}) => routeInbound({ text: t, ...extra });

describe("refs", () => {
  it("parses edit refs with versions, loosely typed", () => {
    expect(parseRef("rf-123 v2")).toEqual({ kind: "rf", ref: "rf-123", n: 123, version: 2 });
    expect(parseRef("RF123V3")).toEqual({ kind: "rf", ref: "rf-123", n: 123, version: 3 });
    expect(parseRef("rf 7")).toEqual({ kind: "rf", ref: "rf-7", n: 7 });
    expect(parseRef("ap-07")).toEqual({ kind: "ap", ref: "ap-7", n: 7 });
    expect(parseRef("top-10")).toBeUndefined();
  });

  it("normalizes approval refs", () => {
    expect(["ap-7", "AP7", "ap 7", "7"].map(normalizeApprovalRef)).toEqual(["ap-7", "ap-7", "ap-7", "ap-7"]);
    expect(normalizeApprovalRef("rf-7")).toBeUndefined();
  });

  it("parses button ids", () => {
    expect(parseActionId("approve:ap-7")).toEqual({ decision: "approve", ref: "ap-7" });
    expect(parseActionId("REJECT:AP-12")).toEqual({ decision: "reject", ref: "ap-12" });
    expect(parseActionId("approve:rf-1")).toBeUndefined();
  });
});

describe("routeInbound", () => {
  it("approves and rejects by button", () => {
    expect(routeInbound({ text: "", actionId: "approve:ap-7" })).toEqual({ type: "decide", ref: "ap-7", decision: "approve" });
    expect(routeInbound({ text: "", actionId: "reject:ap-7" })).toEqual({ type: "decide", ref: "ap-7", decision: "reject" });
    expect(routeInbound({ text: "", actionId: "approvals" })).toEqual({ type: "list_approvals" });
    expect(routeInbound({ text: "", actionId: "old:button" }).type).toBe("invalid");
  });

  it("approves and rejects by typed command, with notes", () => {
    expect(text("approve ap-7")).toEqual({ type: "decide", ref: "ap-7", decision: "approve" });
    expect(text("Approve AP7 looks great")).toEqual({ type: "decide", ref: "ap-7", decision: "approve", note: "looks great" });
    expect(text("reject ap-7: too salesy")).toEqual({ type: "decide", ref: "ap-7", decision: "reject", note: "too salesy" });
    expect(text("revise 7 shorter hook")).toEqual({ type: "decide", ref: "ap-7", decision: "revise", note: "shorter hook" });
  });

  it("routes rf-123 v2 <notes> to an edit revision", () => {
    expect(text("rf-123 v2 make the hook punchier")).toEqual({ type: "revise_edit", ref: "rf-123", version: 2, notes: "make the hook punchier" });
    expect(text("RF-123: cut the first 3 seconds")).toEqual({ type: "revise_edit", ref: "rf-123", notes: "cut the first 3 seconds" });
  });

  it("routes a reply to an edit message, including a new take", () => {
    expect(text("captions bigger", { replyToRef: "rf-123 v2" })).toEqual({ type: "revise_edit", ref: "rf-123", version: 2, notes: "captions bigger" });
    const take = [{ url: "telegram:file/abc", kind: "video" as const }];
    expect(routeInbound({ text: "", replyToRef: "rf-123 v2", attachments: take })).toEqual({
      type: "revise_edit",
      ref: "rf-123",
      version: 2,
      notes: "New take attached.",
      attachments: take,
    });
  });

  it("treats replies to an approval as a decision", () => {
    expect(text("yes", { replyToRef: "ap-7" })).toEqual({ type: "decide", ref: "ap-7", decision: "approve" });
    expect(text("👍", { replyToRef: "ap-7" })).toEqual({ type: "decide", ref: "ap-7", decision: "approve" });
    expect(text("no", { replyToRef: "ap-7" })).toEqual({ type: "decide", ref: "ap-7", decision: "reject" });
    expect(text("drop the price mention", { replyToRef: "ap-7" })).toEqual({ type: "decide", ref: "ap-7", decision: "revise", note: "drop the price mention" });
  });

  it("understands short commands, including Telegram slash commands", () => {
    expect(text("/brief@examplebrand_bot")).toEqual({ type: "brief" });
    expect(text("Approvals")).toEqual({ type: "list_approvals" });
    expect(text("/help")).toEqual({ type: "help" });
    expect(text("demo on")).toEqual({ type: "demo", on: true });
    expect(text("quiet 21:30-07:00")).toEqual({ type: "quiet", window: { start: "21:30", end: "07:00" } });
    expect(text("quiet hours 9:30pm to 7am")).toEqual({ type: "quiet", window: { start: "21:30", end: "07:00" } });
    expect(text("quiet off")).toEqual({ type: "quiet", window: null });
    expect(text("quiet whenever").type).toBe("invalid");
  });

  it("sends everything else to the Chief of Staff", () => {
    expect(text("what should I film this week?")).toEqual({ type: "chat", text: "what should I film this week?" });
    expect(text("approve the one about permits")).toEqual({ type: "chat", text: "approve the one about permits" });
    expect(text("   ")).toEqual({ type: "ignore" });
  });
});

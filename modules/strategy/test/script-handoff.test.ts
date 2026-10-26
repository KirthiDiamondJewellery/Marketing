import { describe, expect, it } from "vitest";
import { isFilmable, pickScriptTargets, writeScriptKey, type ScriptTarget } from "../src/script-handoff.ts";

const item = (id: string, kind: string, over: Partial<ScriptTarget> = {}): ScriptTarget => ({
  id,
  status: "idea",
  kind: "reel",
  filmBy: null,
  brief: { kind },
  ...over,
});

describe("brief → scripts hand-off", () => {
  it("only filmed pieces qualify", () => {
    expect(isFilmable(item("a", "news"))).toBe(true);
    expect(isFilmable(item("b", "offer"))).toBe(true);
    expect(isFilmable(item("c", "talking_head", { kind: "text" }))).toBe(false);
    expect(isFilmable(item("d", "talking_head", { kind: "carousel" }))).toBe(false);
    expect(isFilmable(item("e", "text_post"))).toBe(false);
    expect(isFilmable({ ...item("f", "remix"), brief: {} })).toBe(false);
  });

  it("picks soonest deadline first, keeps slot order for ties, and respects the daily cap", () => {
    const items = [
      item("th1", "talking_head", { filmBy: "2026-10-15T12:00:00Z" }),
      item("news", "news", { filmBy: "2026-10-12T20:00:00Z" }),
      item("txt", "talking_head", { kind: "text", filmBy: "2026-10-12T13:00:00Z" }),
      item("rx1", "remix", { filmBy: "2026-10-14T12:00:00Z" }),
      item("rx2", "remix", { filmBy: "2026-10-14T12:00:00Z" }),
      item("done", "offer", { status: "scripted", filmBy: "2026-10-12T12:00:00Z" }),
      item("offer", "offer"),
    ];
    const r = pickScriptTargets(items, { maxPerDay: 3, alreadyToday: 0 });
    expect(r.picked.map((i) => i.id)).toEqual(["news", "rx1", "rx2"]);
    expect(r.overCap.map((i) => i.id)).toEqual(["th1", "offer"]);
  });

  it("counts what was already queued today against the cap", () => {
    const items = ["a", "b", "c", "d"].map((id) => item(id, "talking_head"));
    expect(pickScriptTargets(items, { maxPerDay: 5, alreadyToday: 0 }).picked).toHaveLength(4);
    expect(pickScriptTargets(items, { maxPerDay: 5, alreadyToday: 3 }).picked.map((i) => i.id)).toEqual(["a", "b"]);
    expect(pickScriptTargets(items, { maxPerDay: 5, alreadyToday: 9 }).picked).toEqual([]);
    expect(pickScriptTargets(items, { maxPerDay: 0, alreadyToday: 0 }).overCap).toHaveLength(4);
  });

  it("dedupes on the content id", () => {
    expect(writeScriptKey("6f1c")).toBe("write-script:6f1c");
  });
});

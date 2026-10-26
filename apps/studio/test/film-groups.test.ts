import { describe, expect, it } from "vitest";
import { groupFilm, ideaState, scriptableIdeas, type FilmRow } from "../src/server/queries/film-groups.ts";

const row = (id: string, over: Partial<FilmRow> = {}): FilmRow => ({ id, status: "idea", kind: "reel", script: null, approval: null, writing: false, ...over });
const script = (status: string, ok: boolean | null = true, version = 1) => ({ id: `s-${status}-${version}`, version, status, ok });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("film page groups", () => {
  it("puts approved scripts in Ready, passing drafts with a pending approval in Waiting, the rest in Ideas", () => {
    const g = groupFilm([
      row("approved", { status: "scripted", script: script("approved") }),
      row("filmed", { status: "filming", script: script("approved") }),
      row("pending", { status: "scripted", script: script("draft"), approval: { id: "a1", ref: "ap-1" } }),
      row("pending-idea", { status: "idea", script: script("draft"), approval: { id: "a2", ref: "ap-2" } }),
      row("fresh"),
      row("writing", { writing: true }),
      row("rejected", { script: script("rejected") }),
      row("failing", { script: script("draft", false) }),
    ]);
    expect(ids(g.ready)).toEqual(["approved", "filmed"]);
    expect(ids(g.waiting)).toEqual(["pending", "pending-idea"]);
    expect(g.ideas.map((i) => [i.id, i.state])).toEqual([
      ["fresh", "new"],
      ["writing", "writing"],
      ["rejected", "rejected"],
      ["failing", "needs_fix"],
    ]);
  });

  it("a draft is never ready to film, even on a scripted piece", () => {
    const g = groupFilm([row("draft", { status: "scripted", script: script("draft", false) })]);
    expect(g.ready).toEqual([]);
    expect(g.waiting).toEqual([]); // no pending approval: it needs a person, not an OK
    expect(g.ideas.map((i) => i.state)).toEqual(["needs_fix"]);
  });

  it("a passing draft without a pending approval isn't offered for a one-click OK", () => {
    const g = groupFilm([row("x", { status: "idea", script: script("draft", true) })]);
    expect(g.waiting).toEqual([]);
    expect(g.ideas.map((i) => [i.id, i.state])).toEqual([["x", "draft"]]);
  });

  it("a piece being rewritten from the owner's notes shows as writing", () => {
    const g = groupFilm([row("rev", { status: "scripted", script: script("draft", true, 2), writing: true })]);
    expect(g.ideas.map((i) => [i.id, i.state])).toEqual([["rev", "writing"]]);
  });

  it("a filmed piece stays on Ready until its take is in; a rejected one doesn't", () => {
    const g = groupFilm([
      row("filmed-draft", { status: "filming", script: script("draft") }),
      row("filmed-rejected", { status: "filming", script: script("rejected") }),
    ]);
    expect(ids(g.ready)).toEqual(["filmed-draft"]);
    expect(g.ideas).toEqual([]);
  });

  it("skips text and carousel pieces and anything past filming", () => {
    const g = groupFilm([
      row("text", { kind: "text" }),
      row("carousel", { kind: "carousel", status: "scripted", script: script("approved") }),
      row("editing", { status: "editing", script: script("approved") }),
      row("story", { kind: "story" }),
    ]);
    expect(ids(g.ready)).toEqual([]);
    expect(ids(g.ideas)).toEqual(["story"]);
  });

  it("keeps the incoming order and picks never-scripted ideas for the button", () => {
    const g = groupFilm(["a", "b", "c", "d", "e", "f", "g"].map((id, i) => row(id, i === 1 ? { writing: true } : i === 2 ? { script: script("rejected") } : {})));
    expect(ids(scriptableIdeas(g.ideas, 3))).toEqual(["a", "d", "e"]);
    expect(scriptableIdeas(g.ideas, 0)).toEqual([]);
    expect(ideaState({ script: null, writing: false })).toBe("new");
  });
});

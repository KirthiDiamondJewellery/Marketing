import { describe, expect, it } from "vitest";
import { addCompetitors, bareHandle, cleanHandle, competitorHandle, matchAccounts, ownHandleList, parseHandleList } from "../src/lib/handles.ts";
import { externalFromSnapshot, pickForTranscription, type OwnPostRow } from "../src/lib/own-posts.ts";

describe("cleaning handles", () => {
  it("accepts handles, @handles and profile links", () => {
    expect(cleanHandle("instagram", "examplebrand")).toBe("@examplebrand");
    expect(cleanHandle("instagram", " @examplebrand ")).toBe("@examplebrand");
    expect(cleanHandle("instagram", "https://www.instagram.com/examplebrand/?hl=en")).toBe("@examplebrand");
    expect(cleanHandle("tiktok", "https://www.tiktok.com/@examplebrand")).toBe("@examplebrand");
    expect(cleanHandle("youtube", "youtube.com/@ExamplebrandStudio")).toBe("@ExamplebrandStudio");
    expect(cleanHandle("youtube", "https://www.youtube.com/channel/UC1234567890abcdef")).toBe("channel/UC1234567890abcdef");
    expect(cleanHandle("x", "https://x.com/examplebrand")).toBe("@examplebrand");
  });

  it("keeps LinkedIn's page kind", () => {
    expect(cleanHandle("linkedin", "https://www.linkedin.com/in/demo-person-1/")).toBe("in/demo-person-1");
    expect(cleanHandle("linkedin", "linkedin.com/company/examplebrand")).toBe("company/examplebrand");
    expect(cleanHandle("linkedin", "demo-person-1")).toBe("in/demo-person-1");
  });

  it("refuses junk", () => {
    expect(cleanHandle("instagram", "")).toBe("");
    expect(cleanHandle("instagram", "two words")).toBe("");
    expect(cleanHandle("instagram", "<script>")).toBe("");
  });

  it("splits pasted lists and drops duplicates", () => {
    expect(parseHandleList("tiktok", "@a.one, @b_two\nhttps://www.tiktok.com/@a.one  c-three")).toEqual(["@a.one", "@b_two", "@c-three"]);
    expect(bareHandle("@Example")).toBe("example");
    expect(competitorHandle("linkedin", "linkedin.com/in/Demo-Person-1")).toBe("@demo-person-1");
  });

  it("lists the owner's handles, skipping empty and unknown platforms", () => {
    expect(ownHandleList({ instagram: "examplebrand", tiktok: "", youtube: "@qf" })).toEqual([
      { platform: "instagram", handle: "@examplebrand" },
      { platform: "youtube", handle: "@qf" },
    ]);
  });
});

describe("matching handles to connected accounts", () => {
  it("says which platforms are connected, different, expired or missing", () => {
    const m = matchAccounts(
      { instagram: "@examplebrand", tiktok: "@examplebrand", youtube: "@examplebrand", linkedin: "in/demo-person-1" },
      [
        { platform: "instagram", handle: "examplebrand", status: "connected" },
        { platform: "tiktok", handle: "examplebrand.old", status: "connected" },
        { platform: "youtube", handle: "examplebrand", status: "expired" },
        { platform: "facebook", handle: "examplebrand", status: "connected" },
      ],
    );
    expect(m.map((x) => [x.platform, x.state])).toEqual([
      ["instagram", "connected"],
      ["tiktok", "other"],
      ["youtube", "expired"],
      ["linkedin", "missing"],
      ["facebook", "extra"],
    ]);
  });
});

describe("competitor list", () => {
  const make = (c: { handle: string; platform: "instagram" | "tiktok" | "youtube" | "linkedin" | "x" | "facebook" | "threads" }) => ({ ...c, tier: "core" as const });

  it("adds cleaned handles, never the owner's own, no duplicates, up to the cap", () => {
    const first = addCompetitors([], "instagram", ["@a", "https://instagram.com/b/", "@examplebrand", "@a", "bad handle"], { own: { instagram: "@ExampleBrand" }, max: 3, make });
    expect(first.list.map((c) => c.handle)).toEqual(["@a", "@b"]);
    expect(first.skipped.map((s) => s.reason)).toEqual(["own", "duplicate", "invalid"]);
    const second = addCompetitors(first.list, "instagram", ["@c", "@d"], { max: 3, make });
    expect(second.list).toHaveLength(3);
    expect(second.skipped).toEqual([{ handle: "@d", reason: "full" }]);
    // The cap is per platform.
    expect(addCompetitors(second.list, "tiktok", ["@a"], { max: 3, make }).list).toHaveLength(4);
  });
});

describe("own posts", () => {
  const row = (over: Partial<OwnPostRow>): OwnPostRow => ({
    id: Math.random().toString(36).slice(2),
    platform: "instagram",
    url: "https://www.instagram.com/reel/x/",
    views: null,
    publishedAt: "2026-09-01T00:00:00.000Z",
    videoUrl: null,
    durationS: null,
    transcript: null,
    transcriptStatus: null,
    ...over,
  });

  it("transcribes the best videos first and skips done, pending, very short or non-video posts", () => {
    const posts = [
      row({ id: "low", views: 100 }),
      row({ id: "top", views: 9000 }),
      row({ id: "mid", views: 2000, videoUrl: "https://cdn.example/v.mp4" }),
      row({ id: "done", views: 99999, transcript: "already here" }),
      row({ id: "pending", views: 99999, transcriptStatus: "queued" }),
      row({ id: "short", views: 99999, durationS: 2 }),
      row({ id: "linkedin", platform: "linkedin", views: 99999 }),
      row({ id: "li-video", platform: "linkedin", views: 50, videoUrl: "https://cdn.example/li.mp4" }),
    ];
    expect(pickForTranscription(posts, 3).map((p) => p.id)).toEqual(["top", "mid", "low"]);
    expect(pickForTranscription(posts, 10).map((p) => p.id)).toEqual(["top", "mid", "low", "li-video"]);
    // Without a downloader only posts with a direct media link qualify.
    expect(pickForTranscription(posts, 10, { canDownload: false }).map((p) => p.id)).toEqual(["mid", "li-video"]);
  });

  it("turns an analytics snapshot into a post, or nothing without an id and link", () => {
    const p = externalFromSnapshot({ platformPostId: "123", platform: "tiktok", capturedAt: "2026-10-01T00:00:00.000Z", url: "https://www.tiktok.com/@q/video/123", caption: "Hello", views: 50 }, "@Q");
    expect(p).toEqual({ platform: "tiktok", platformPostId: "123", authorHandle: "q", url: "https://www.tiktok.com/@q/video/123", publishedAt: "2026-10-01T00:00:00.000Z", caption: "Hello", views: 50 });
    expect(externalFromSnapshot({ platformPostId: "1", platform: "tiktok", capturedAt: "2026-10-01T00:00:00.000Z" }, "q")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { canonicalUrl, contentWords, detectCrossCreatorTrends, jaccard, spokenHook, topicKeysOf, transcriptFingerprint } from "../src/index.ts";

describe("text helpers", () => {
  it("extracts stemmed content words without stop words, URLs or numbers", () => {
    expect(contentWords("Hiring contractors? 3 mistakes https://example.com/x when you are hiring #permits")).toEqual([
      "hir", "contractor", "mistak", "permit",
    ]);
    expect(contentWords(null)).toEqual([]);
  });
  it("jaccard", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(["a"], ["a"])).toBe(1);
  });
  it("fingerprints transcripts so trial variants collide", () => {
    const a = transcriptFingerprint("[music] Here's the ONE permit mistake that costs you a month!");
    const b = transcriptFingerprint("Here's the one permit mistake that costs you a month ♪la la♪");
    expect(a).toBe(b);
    expect(transcriptFingerprint("")).toBe("");
    expect(transcriptFingerprint("x".repeat(500)).length).toBe(220);
  });
  it("extracts the spoken hook", () => {
    expect(spokenHook("Okay. Stop pouring footings before the inspection. Here is why. It matters.")).toBe(
      "Okay. Stop pouring footings before the inspection.",
    );
    expect(spokenHook("one two three four five six", 3)).toBe("one two three");
    expect(spokenHook(undefined)).toBe("");
  });
  it("canonicalises URLs", () => {
    expect(canonicalUrl("https://WWW.Example.com/a/b/?utm_source=x&id=3#frag")).toBe("example.com/a/b?id=3");
    expect(canonicalUrl("not a url ")).toBe("not a url");
  });
});

describe("cross-creator trends", () => {
  it("needs the same topic from at least two creators", () => {
    const trends = detectCrossCreatorTrends([
      { postId: "p1", creator: "ig:a", text: "Kitchen remodel budget mistakes" },
      { postId: "p2", creator: "ig:a", text: "Another kitchen remodel story" },
      { postId: "p3", creator: "ig:b", text: "Why your kitchen remodel runs late", keys: ["pattern:question"] },
      { postId: "p4", creator: "ig:c", text: "Permit timelines explained", keys: ["pattern:question"] },
    ]);
    const keys = trends.map((t) => t.key);
    expect(keys).toContain("topic:kitchen");
    expect(keys).toContain("pattern:question");
    expect(keys).not.toContain("topic:permit");
    const kitchen = trends.find((t) => t.key === "topic:kitchen")!;
    expect(kitchen.creators).toEqual(["ig:a", "ig:b"]);
    expect(kitchen.postIds).toEqual(["p1", "p2", "p3"]);
  });
  it("drops topics that are in most posts once there are enough posts", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ postId: `p${i}`, creator: `c${i}`, text: i < 4 ? "business owners growth" : "permit" }));
    const keys = detectCrossCreatorTrends(items).map((t) => t.key);
    expect(keys).not.toContain("topic:business");
    expect(keys).toContain("topic:permit");
  });
  it("respects minCreators and keeps explicit keys", () => {
    const items = [
      { postId: "p1", creator: "a", keys: ["format:split"] },
      { postId: "p2", creator: "b", keys: ["format:split"] },
    ];
    expect(detectCrossCreatorTrends(items, { minCreators: 3 })).toEqual([]);
    expect(topicKeysOf({ postId: "x", creator: "a", keys: ["k"], text: "decks" })).toEqual(["k", "topic:deck"]);
  });
});

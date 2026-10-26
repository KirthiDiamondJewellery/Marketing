import { describe, expect, it } from "vitest";
import { createMasker, fakeHandle, fakeName, maskPairs, maskText } from "../src/lib/mask.ts";

describe("demo mode masking", () => {
  const pairs = maskPairs({ names: ["Pat Example"], handles: ["@pat.builds"], emails: ["pat@example.org"] });

  it("is deterministic per person", () => {
    expect(fakeName("Pat Example")).toBe(fakeName("pat example"));
    expect(fakeHandle("@pat.builds")).toBe(fakeHandle("pat.builds"));
    expect(fakeHandle("pat.builds")).toMatch(/^@member_[0-9a-f]{4}$/);
  });

  it("replaces names, handles and emails but keeps numbers", () => {
    const out = maskText("Pat Example (@pat.builds, pat@example.org) asked about a $42,000 remodel, 3.1× views", pairs);
    expect(out).not.toMatch(/Pat|pat\.builds|pat@example/);
    expect(out).toContain("$42,000 remodel, 3.1× views");
    expect(out).toContain(fakeName("Pat Example"));
    expect(out).toContain(fakeHandle("pat.builds"));
  });

  it("masks first names on their own and leaves unrelated words", () => {
    const out = maskText("Thanks Pat, the patio looks great", pairs);
    expect(out).toBe(`Thanks ${fakeName("Pat Example").split(" ")[0]}, the patio looks great`);
  });

  it("is a no-op when off", () => {
    expect(createMasker(false, pairs).text("Pat Example")).toBe("Pat Example");
    expect(createMasker(true, pairs).text("Pat Example")).toBe(fakeName("Pat Example"));
  });
});

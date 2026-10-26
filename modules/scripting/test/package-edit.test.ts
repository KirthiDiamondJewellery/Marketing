import { describe, expect, it } from "vitest";
import { validateScript } from "@attentionos/guardrails";
import { applyPatch, completePackage } from "../src/index.ts";
import { lastPackage, rememberPackage } from "../src/package-edit.ts";
import { rules, validPackage } from "../../../packages/guardrails/test/fixtures.ts";

/** Fewer words to type: body and hook text come from the beats; revisions send only what changed. */
describe("package completion and patches", () => {
  const { body: _body, hookText: _hook, ...withoutDerived } = validPackage() as Record<string, unknown>;

  it("builds the body and the hook text from the beats", () => {
    const pkg = completePackage(withoutDerived);
    expect(pkg.body).toBe(validPackage().body);
    expect(pkg.hookText).toBe(validPackage().hookText);
    expect(validateScript(pkg, rules()).errors).toEqual([]);
    // Given fields are kept as they are.
    expect(completePackage({ ...withoutDerived, hookText: "Custom" }).hookText).toBe("Custom");
  });

  it("applies beat edits, merges captions per platform and rebuilds what depends on the beats", () => {
    const base = completePackage(withoutDerived);
    const next = applyPatch(base, {
      beatEdits: [{ index: 0, text: "Remodel budgets break in week one. Here's the line that does it." }],
      captions: { x: { text: "Budgets break in week one.", hashtags: [] } },
    });
    expect(next.hookText).toBe("Remodel budgets break in week one.");
    expect(String(next.body).startsWith("Remodel budgets break in week one.")).toBe(true);
    expect((next.captions as Record<string, unknown>).instagram).toEqual((base.captions as Record<string, unknown>).instagram);
    expect((next.captions as Record<string, { text: string }>).x!.text).toBe("Budgets break in week one.");
    // An edit to a later beat keeps the hook text; a bad index is ignored.
    const later = applyPatch(base, { beatEdits: [{ index: 4, text: "Short play." }, { index: 99, text: "nope" }] });
    expect(later.hookText).toBe(base.hookText);
    expect((later.beats as { text: string }[])[4]!.text).toBe("Short play.");
    expect((later.beats as unknown[]).length).toBe((base.beats as unknown[]).length);
    // Top-level fields replace.
    expect(applyPatch(base, { claimLedger: [] }).claimLedger).toEqual([]);
  });

  it("remembers the last package per content for the next patch", () => {
    rememberPackage("c-1", { title: "one" });
    rememberPackage("c-1", { title: "two" });
    expect(lastPackage("c-1")).toEqual({ title: "two" });
    expect(lastPackage("c-2")).toBeNull();
  });
});

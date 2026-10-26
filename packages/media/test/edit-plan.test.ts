import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { editPlanJsonSchema, planOutputDuration, safeZoneMargins, validateEditPlan, parseEditPlan, EditPlanError } from "../src/index.ts";
import { renderSchemas, SCHEMA_TARGETS } from "../scripts/export-schema.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
/** Shared with media-py's tests: both sides must accept the same plan. */
const fixture = () => JSON.parse(readFileSync(resolve(ROOT, "media-py/tests/fixtures/plan.json"), "utf8"));

describe("EditPlan schema", () => {
  it("accepts the shared fixture and fills defaults", () => {
    const r = validateEditPlan(fixture());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.plan;
    expect(p.export).toMatchObject({ w: 1080, h: 1920, fps: 30, codec: "h264", bitrate: "12M" });
    expect(p.layout.segments[0]!.speaker).toEqual({ position: "bottom", focus: "face" });
    expect(p.layout.segments[1]!.visual).toEqual({ assetId: "screen-1", in: 1.5, loop: false });
    expect(p.audio.music).toBeNull();
    // preset fills margins; explicit margins win
    expect(p.captions.safeZone).toMatchObject({ preset: "reels", top: 220, bottom: 400, left: 60, right: 140 });
    expect(planOutputDuration(p)).toBeCloseTo(9.7, 5);
  });

  it("fills a minimal plan", () => {
    const p = parseEditPlan({
      format: "raw-talking-head",
      source: { media: { path: "/x.mp4", durationS: 5 }, timeMap: { keepRanges: [{ start: 0, end: 5 }] } },
    });
    expect(p.version).toBe(1);
    expect(p.captions.style).toBe("bold-pop");
    expect(p.source.timeMap.fps).toBe(30);
    expect(p.source.transcript.words).toEqual([]);
    expect(p.captions.safeZone).toMatchObject({ top: 240, bottom: 440, left: 60, right: 160 });
  });

  it.each([
    ["overlapping segments", (p: any) => { p.layout.segments[1].start = 2.5; }, "inside segment"],
    ["segment past the end", (p: any) => { p.layout.segments[2].dur = 5; }, "past the end"],
    ["split without a visual", (p: any) => { delete p.layout.segments[1].visual; }, "needs a visual"],
    ["export fps differs from the time map", (p: any) => { p.export.fps = 25; }, "must match"],
    ["keep range after the footage", (p: any) => { p.source.timeMap.keepRanges[1].end = 20; }, "after the footage ends"],
    ["screenshot without asset", (p: any) => { p.overlays.push({ kind: "screenshot", at: 1, dur: 1 }); }, "needs an assetId"],
    ["unknown layout mode", (p: any) => { p.layout.segments[0].mode = "sideways"; }, "mode"],
    ["b-roll without license", (p: any) => { delete p.broll[0].license; }, "license"],
  ])("rejects %s", (_label, mutate, needle) => {
    const p = fixture();
    mutate(p);
    const r = validateEditPlan(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.issues)).toContain(needle);
  });

  it("throws EditPlanError with plain issues", () => {
    expect(() => parseEditPlan({ format: "X!" })).toThrow(EditPlanError);
  });

  it("margins scale to other frame sizes and accept fractions", () => {
    expect(safeZoneMargins({ preset: "universal" }, 540, 960)).toEqual({ top: 120, bottom: 220, left: 30, right: 80 });
    expect(safeZoneMargins({ preset: "universal", bottom: 0.25 }, 1080, 1920).bottom).toBe(480);
  });

  it("the JSON Schema committed for media-py is up to date", () => {
    const schemas = renderSchemas();
    expect(readFileSync(SCHEMA_TARGETS.editPlan, "utf8")).toBe(schemas.editPlan);
    expect(readFileSync(SCHEMA_TARGETS.format, "utf8")).toBe(schemas.format);
    const js = editPlanJsonSchema() as { properties: Record<string, unknown>; required?: string[] };
    expect(js.required).toEqual(expect.arrayContaining(["source", "format"]));
    expect(Object.keys(js.properties)).toEqual(expect.arrayContaining(["layout", "captions", "overlays", "broll", "audio", "camera", "export"]));
  });
});

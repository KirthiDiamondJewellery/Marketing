import { describe, expect, it } from "vitest";
import { preflight, type PreflightContext, type PreflightEditPlan } from "../src/index.ts";
import { codes, warnCodes } from "./fixtures.ts";

const files = new Set(["/ws/media/raw/take1.mp4", "/ws/media/assets/chart.png", "/ws/media/assets/broll1.mp4", "/ws/media/renders/seg1.mp4", "/ws/media/renders/final.mp4"]);

function plan(): PreflightEditPlan {
  return {
    source: { media: "media/raw/take1.mp4", timeMap: { keepRanges: [{ start: 0, end: 20 }, [25, 35]] } },
    format: "split-demo",
    layout: {
      segments: [
        { mode: "split", start: 0, dur: 5 },
        { mode: "fullVisual", start: 5, dur: 10 },
        { mode: "full", start: 15, dur: 10 },
        { mode: "full", start: 25, dur: 5 },
      ],
    },
    captions: { style: "bold", safeZone: { top: 0.1, bottom: 0.2, left: 0.05, right: 0.05 } },
    overlays: [
      { kind: "headline", at: 0, dur: 3, text: "Budgets break early" },
      { kind: "chart", at: 6, dur: 4, assetId: "chart", evidenceId: "c1" },
      { kind: "headline", at: 12, dur: 2, text: "42 projects tracked", evidenceId: "c1" },
    ],
    broll: [{ assetId: "media/assets/broll1.mp4", at: 16, dur: 3, license: "own footage" }],
    audio: { sfx: [{ kind: "whoosh", at: 5 }], loudness: -14, truePeak: -1 },
    camera: [{ kind: "push", at: 0, dur: 2 }],
    export: { w: 1080, h: 1920, fps: 30, codec: "h264" },
  };
}

const signed = (...kinds: ("edit_map" | "plan" | "playback" | "claims")[]) => kinds.map((kind) => ({ kind, by: "user:owner", at: "2026-10-15T10:00:00Z" }));
const ctx = (over: Partial<PreflightContext> = {}): PreflightContext => ({
  baseDir: "/ws",
  assets: { chart: { uri: "media/assets/chart.png" } },
  fileExists: (p) => files.has(p),
  claimLedger: [
    { id: "c1", claim: "We tracked 42 projects", verdict: "PASS", source: "proof:project-tracker" },
    { id: "c9", claim: "Remodels always run over", verdict: "CUT" },
  ],
  signoffs: signed("edit_map"),
  ...over,
});

describe("preflight plan stage", () => {
  it("passes a complete plan", () => {
    const r = preflight("plan", plan(), ctx());
    expect(r.errors).toEqual([]);
  });

  const cases: [string, (p: PreflightEditPlan) => unknown, Partial<PreflightContext>, string[]][] = [
    ["no plan", () => null, {}, ["preflight.no_plan"]],
    ["missing format", (p) => ({ ...p, format: "" }), {}, ["preflight.format_missing"]],
    ["missing source file", (p) => ({ ...p, source: { ...p.source, media: "media/raw/missing.mp4" } }), {}, ["preflight.asset_missing"]],
    ["overlay asset missing", (p) => ({ ...p, overlays: [{ kind: "logo", at: 0, dur: 1, assetId: "nope.png" }] }), {}, ["preflight.asset_missing"]],
    ["claim overlay without evidence", (p) => ({ ...p, overlays: [{ kind: "headline", at: 1, dur: 1, text: "18% under quote" }] }), {}, ["preflight.evidence_missing"]],
    ["chart without evidence", (p) => ({ ...p, overlays: [{ kind: "chart", at: 1, dur: 1, assetId: "chart" }] }), {}, ["preflight.evidence_missing"]],
    ["evidence not in ledger", (p) => ({ ...p, overlays: [{ kind: "chart", at: 1, dur: 1, assetId: "chart", evidenceId: "zz" }] }), {}, ["preflight.evidence_unknown"]],
    ["evidence marked CUT", (p) => ({ ...p, overlays: [{ kind: "headline", at: 1, dur: 1, claim: true, evidenceId: "c9" }] }), {}, ["preflight.evidence_not_pass"]],
    ["overlapping segments", (p) => ({ ...p, layout: [{ mode: "split", start: 0, dur: 20 }, { mode: "full", start: 15, dur: 15 }] }), {}, ["preflight.layout_overlap"]],
    ["layout not starting at 0", (p) => ({ ...p, layout: [{ mode: "split", start: 1, dur: 29 }] }), {}, ["preflight.layout_start"]],
    ["unknown layout mode", (p) => ({ ...p, layout: [{ mode: "pip", start: 0, dur: 30 }] }), {}, ["preflight.layout_mode"]],
    ["segment past end", (p) => ({ ...p, layout: [{ mode: "split", start: 0, dur: 40 }] }), {}, ["preflight.layout_past_end"]],
    ["fullVisual share too low", (p) => p, { fullVisualShare: { min: 0.6 } }, ["preflight.layout_ratio"]],
    ["wrong aspect", (p) => ({ ...p, export: { w: 1080, h: 1080, fps: 30 } }), {}, ["preflight.aspect"]],
    ["safe zone too small (px)", (p) => ({ ...p, captions: { style: "bold", safeZone: { top: 50, bottom: 400 } } }), {}, ["preflight.safe_zone_small"]],
    ["safe zone missing", (p) => ({ ...p, captions: { style: "bold" } }), {}, ["preflight.safe_zone_missing"]],
    ["broll without license", (p) => ({ ...p, broll: [{ assetId: "media/assets/broll1.mp4", at: 1, dur: 1 }] }), {}, ["preflight.broll_license"]],
    ["overlay past end", (p) => ({ ...p, overlays: [{ kind: "logo", at: 29, dur: 5 }] }), {}, ["preflight.timing"]],
    ["sfx outside video", (p) => ({ ...p, audio: { sfx: [{ kind: "hit", at: 31 }], loudness: -14, truePeak: -1 } }), {}, ["preflight.timing"]],
    ["loudness target wrong", (p) => ({ ...p, audio: { loudness: -9, truePeak: 0 } }), {}, ["preflight.loudness", "preflight.true_peak"]],
    ["edit map not signed off", (p) => p, { signoffs: [] }, ["preflight.signoff_missing"]],
  ];
  it.each(cases)("%s", (_n, mutate, over, expected) => {
    expect(codes(preflight("plan", mutate(plan()), ctx(over)))).toEqual(expected);
  });

  it("warns on a gap between segments", () => {
    const p = { ...plan(), layout: [{ mode: "split" as const, start: 0, dur: 10 }, { mode: "full" as const, start: 11, dur: 19 }] };
    expect(warnCodes(preflight("plan", p, ctx()))).toContain("preflight.layout_gap");
  });
});

describe("preflight render and final stages", () => {
  it("render needs the plan signed off and segments rendered", () => {
    const r = preflight("render", plan(), ctx({ renderOutputs: ["media/renders/seg1.mp4", "media/renders/seg2.mp4"] }));
    expect(codes(r)).toEqual(["preflight.render_missing", "preflight.signoff_missing"]);
    const ok = preflight("render", plan(), ctx({ renderOutputs: ["media/renders/seg1.mp4"], signoffs: signed("edit_map", "plan") }));
    expect(ok.errors).toEqual([]);
  });

  it("final checks the export and all sign-offs", () => {
    const base = ctx({ signoffs: signed("edit_map", "plan", "playback", "claims"), exportPath: "media/renders/final.mp4", exportProbe: { width: 1080, height: 1920, fps: 30, durationS: 30 } });
    expect(preflight("final", plan(), base).errors).toEqual([]);
    expect(codes(preflight("final", plan(), { ...base, exportProbe: { width: 720, height: 1280, fps: 25 } }))).toEqual(["preflight.export_size", "preflight.export_fps"]);
    expect(codes(preflight("final", plan(), { ...base, exportPath: undefined, exportProbe: undefined }))).toEqual(["preflight.export_file_missing", "preflight.export_unprobed"]);
    const missing = preflight("final", plan(), { ...base, signoffs: signed("edit_map", "plan") });
    expect(missing.errors.map((e) => e.message)).toEqual(["Nobody has signed off on a full playback review yet.", "Nobody has signed off on the factual claims review yet."]);
  });

  it("required sign-offs are configurable", () => {
    expect(preflight("plan", plan(), ctx({ signoffs: [], requiredSignoffs: { plan: [] } })).ok).toBe(true);
  });
});

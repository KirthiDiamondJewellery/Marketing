import { describe, expect, it } from "vitest";
import {
  draftPlan,
  formatAutoSfx,
  formatCutOptions,
  formatMotion,
  hookHeadline,
  listFormats,
  loadFormat,
  parseEditMap,
  summarizeEditMap,
  validateEditPlan,
} from "../src/index.ts";

const base = {
  format: "raw-talking-head",
  source: { media: { path: "/x.mp4", durationS: 10 }, timeMap: { keepRanges: [{ start: 0, end: 10 }] } },
};

const editMap = () =>
  parseEditMap({
    version: 1,
    status: "approved",
    fps: 30,
    source: { path: "/tmp/p.mp4", durationS: 12 },
    keepRanges: [{ start: 0.4, end: 5 }, { start: 6, end: 11 }],
    cuts: [
      { start: 5, end: 5.4, kind: "filler", reason: "Filler “um”.", words: ["um"] },
      { start: 5.4, end: 6, kind: "silence", reason: "Pause." },
    ],
    stats: { sourceS: 12, outputS: 9.6, removedS: 2.4, cutCount: 2 },
  });

describe("engine options on the EditPlan (all optional, additive)", () => {
  it("accepts motion, look, voice, crossfades, auto SFX, caption colours, tracking and encoder", () => {
    const r = validateEditPlan({
      ...base,
      layout: { segments: [{ mode: "full", start: 0, dur: 10, speaker: { focus: "face", track: false } }] },
      captions: { style: "bold-pop", activeColor: "#3DDC97", emphasisColor: "#FFD60A", scale: 1.15 },
      audio: { voice: { denoise: "light", deess: true, compress: false, highpassHz: 90 }, crossfadeMs: 20, autoSfx: "layout", sfx: [{ kind: "zoom", at: 1 }] },
      motion: { jumpCutZoom: 0.08, punchIns: "sentences", punchScale: 0.05, minGapS: 3, hookPush: false, maxZoom: 1.2 },
      look: { color: "auto", strength: 0.5, grade: "warm", sharpen: "off" },
      export: { encoder: "hardware" },
    });
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
    if (!r.ok) return;
    expect(r.plan.motion?.punchIns).toBe("sentences");
    expect(r.plan.look?.grade).toBe("warm");
    expect(r.plan.audio.voice?.highpassHz).toBe(90);
  });

  it("leaves plans without the new fields unchanged", () => {
    const r = validateEditPlan(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.motion).toBeUndefined();
    expect(r.plan.look).toBeUndefined();
    expect(r.plan.audio.autoSfx).toBeUndefined();
  });

  it("rejects out-of-range knobs in plain language", () => {
    const r = validateEditPlan({ ...base, motion: { jumpCutZoom: 0.9 }, captions: { activeColor: "green" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["motion.jumpCutZoom", "captions.activeColor"]));
  });
});

describe("format → plan defaults", () => {
  it("maps each format's camera and audio rules onto motion and code-placed sounds", () => {
    const raw = loadFormat("raw-talking-head");
    expect(formatMotion(raw)).toMatchObject({ jumpCutZoom: 0.07, punchIns: "off", hookPush: false });
    expect(formatAutoSfx(raw)).toBe("off");
    const news = loadFormat("news-greenscreen");
    expect(formatMotion(news)).toMatchObject({ jumpCutZoom: 0, punchIns: "off", hookPush: true });
    expect(formatAutoSfx(news)).toBe("all");
    expect(formatAutoSfx(loadFormat("split-demo"))).toBe("layout");
  });

  it("passes the cutting options through and keeps the sentence pause under the pause limit", () => {
    for (const id of listFormats()) {
      const o = formatCutOptions(loadFormat(id));
      expect(o).toMatchObject({ restarts: true, fillers: true, fillerIslands: true });
      expect(o.sentencePauseS).toBeLessThan(o.maxPauseS);
    }
  });

  it("drafts a hook headline from the first kept sentence and a plan that validates", () => {
    const words = [
      { text: "Most", start: 0.5, end: 0.7 },
      { text: "teams", start: 0.7, end: 1.0 },
      { text: "skip", start: 1.0, end: 1.2 },
      { text: "this.", start: 1.2, end: 1.5 },
      { text: "Here's", start: 6.1, end: 6.4 },
      { text: "why.", start: 6.4, end: 6.7 },
    ];
    const plan = draftPlan({ format: loadFormat("raw-talking-head"), editMap: editMap(), transcript: { language: "en", words }, source: { path: "/tmp/p.mp4", durationS: 12 } });
    expect(plan.overlays).toEqual([{ kind: "headline", at: 0, dur: 2.5, text: "Most teams skip this." }]);
    expect(plan.motion).toMatchObject({ punchIns: "off" });
    expect(plan.look).toMatchObject({ color: "auto" });
    expect(plan.audio).toMatchObject({ autoSfx: "off" });
    expect(validateEditPlan(plan).ok).toBe(true);
    for (const id of listFormats()) {
      const f = loadFormat(id);
      const p = draftPlan({ format: f, editMap: editMap(), transcript: { language: "en", words }, source: { path: "/tmp/p.mp4", durationS: 12 } });
      expect(p.overlays?.length).toBe(f.overlaySlots.some((s) => s.kind === "headline" && s.max > 0) ? 1 : 0);
    }
  });

  it("trims hook headlines and skips one-word openers", () => {
    expect(hookHeadline([{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }, { text: "five" }, { text: "six" }, { text: "seven" }, { text: "eight" }, { text: "nine" }])).toBe(
      "one two three four five six seven eight",
    );
    expect(hookHeadline([{ text: "Look," }, { text: "this" }])).toBe("Look, this");
    expect(hookHeadline([{ text: "Hi." }])).toBeNull();
  });

  it("names filler cuts in the cut-list summary", () => {
    expect(summarizeEditMap(editMap())).toBe("Cut 1 filler, 1 pause: 12.0s → 9.6s.");
  });
});

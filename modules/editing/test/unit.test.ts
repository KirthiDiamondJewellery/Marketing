import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { moduleManifestSchema } from "@attentionos/core";
import { parseEditPlan, TimeMap } from "@attentionos/media";
import { ingestTranscriptInputSchema, REPLY_TO, transcriptionRequestSchema } from "@attentionos/module-research";
import { describe, expect, it } from "vitest";
import editing, { cleanPlan, normaliseRequest, outputTranscriptLines, parseRevisionText, planAssetIds, planDigests, planPrompt, reviseInput, revisePrompt, revisionKind, spokenHook, transcribeInput, toPreflightPlan } from "../src/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const fixturePlan = () => parseEditPlan(JSON.parse(readFileSync(resolve(ROOT, "media-py/tests/fixtures/plan.json"), "utf8")));

describe("editing module definition", () => {
  it("has a valid manifest, five jobs and prefixed tools", () => {
    expect(moduleManifestSchema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, "../module.json"), "utf8")))).toMatchObject({ id: "editing", agent: "art_director", tier: "default", level: 2 });
    expect(editing.jobs.map((j) => j.id).sort()).toEqual(["editing.plan", "editing.prep", "editing.render", "editing.revise", "editing.transcribe"]);
    expect(editing.tools.map((t) => t.name)).toEqual([
      "editing_start_edit", "editing_get_edit_job", "editing_approve_cut_list", "editing_get_plan", "editing_save_plan",
      "editing_request_render", "editing_add_revision_note", "editing_get_qc_report",
    ]);
    for (const t of editing.tools) expect(t.name).toMatch(/^editing_[a-z]+_[a-z_]+$/);
    const llm = editing.jobs.filter((j) => j.kind === "llm");
    for (const j of llm) {
      expect(j.kind === "llm" && j.budgetUsd).toBeLessThanOrEqual(0.5);
      expect(j.kind === "llm" && j.allowedTools.every((t) => t === "Read" || t.startsWith("mcp__attentionos__editing_"))).toBe(true);
    }
    for (const skill of ["reel-editor", "media-hunt", "edit-notes"]) {
      const md = readFileSync(resolve(import.meta.dirname, `../skills/${skill}/SKILL.md`), "utf8");
      expect(md).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
    }
  });

  it("prompts reference Brand Kit files by path only", () => {
    const p = planPrompt("rf-3");
    expect(p).toContain("brand/house-style.md");
    expect(p).toContain('editing_get_plan with {"ref": "rf-3"}');
    const r = revisePrompt({ ref: "rf-3", fromVersion: 2, notes: "tighten the hook", attachments: [{ kind: "video" }] });
    expect(r).toContain("from v2");
    expect(r).toContain("new take");
  });

  it("accepts the revise input the ops module enqueues", () => {
    const parsed = reviseInput.parse({ ref: "RF-12", fromVersion: 2, notes: "tighten the hook", attachments: [{ url: "https://example.com/f", kind: "video", fileName: "take.mov" }], source: { channel: "telegram", messageId: "55" } });
    expect(parsed.ref).toBe("rf-12");
    expect(reviseInput.safeParse({ ref: "rf-1", notes: "x" }).success).toBe(false);
  });

  it("round-trips the research transcription hand-off shapes", () => {
    const req = transcriptionRequestSchema.parse({
      kind: "external_post", externalPostId: "8d6f4c1e-1b7a-4d5b-9a51-3e2f4c5d6e7f", url: "https://example.com/p/1", mediaUrl: "https://example.com/v.mp4",
      destDir: "research/8d6f4c1e-1b7a-4d5b-9a51-3e2f4c5d6e7f", replyTo: REPLY_TO, then: { jobId: "research.teardown", agent: "analyst", input: { x: 1 } },
    });
    const parsed = transcribeInput.parse(req);
    expect(normaliseRequest(parsed)).toEqual(req);
    const short = normaliseRequest(transcribeInput.parse({ externalPostId: req.externalPostId, localPath: "media/research/x.mp4" }));
    expect(short).toMatchObject({ kind: "external_post", mediaPath: "media/research/x.mp4", replyTo: { jobId: "research.ingest-transcript", agent: "analyst" } });
    const reply = ingestTranscriptInputSchema.parse({ externalPostId: req.externalPostId, transcript: { text: "hi there", language: "en", durationS: 1.2, words: [{ text: "hi", start: 0, end: 0.4 }] }, then: req.then });
    expect(reply.then?.jobId).toBe("research.teardown");
  });
});

describe("revision helpers", () => {
  it("parses revision references", () => {
    expect(parseRevisionText("rf-12 v2: tighten the hook")).toEqual({ ref: "rf-12", version: 2, notes: "tighten the hook" });
    expect(parseRevisionText("RF-7 no music please")).toEqual({ ref: "rf-7", version: null, notes: "no music please" });
    expect(parseRevisionText("approve ap-3")).toBeNull();
  });

  it("classifies audio-only revisions so QC can demand an identical picture", () => {
    const a = fixturePlan();
    const b = fixturePlan();
    b.audio.sfx.push({ kind: "ding", at: 2, gainDb: 0 });
    const c = fixturePlan();
    c.overlays[0]!.text = "Something else";
    expect(revisionKind(planDigests(a), planDigests(b))).toBe("audio_only");
    expect(revisionKind(planDigests(a), planDigests(c))).toBe("video");
    expect(revisionKind(planDigests(a), planDigests(a))).toBe("none");
    expect(revisionKind(null, planDigests(a))).toBe("full");
  });

  it("derives a spoken hook", () => {
    const w = (text: string, start: number) => ({ text, start, end: start + 0.3 });
    expect(spokenHook([w("Most", 0), w("teams", 0.3), w("skip", 0.6), w("this.", 0.9), w("Here's", 1.4)])).toBe("Most teams skip this.");
    expect(spokenHook([w("no", 0), w("sentence", 1), w("end", 2), w("at", 3), w("all", 4)])).toBe("no sentence end at");
  });
});

describe("plan adapters", () => {
  it("lists assets and adapts the plan for the guardrails gate", () => {
    const p = fixturePlan();
    expect(planAssetIds(p).sort()).toEqual(["loop-1", "screen-1", "shot-1"]);
    const pf = toPreflightPlan(p);
    expect(pf.source.media).toBe(p.source.media.path);
    expect(pf.durationS).toBeCloseTo(9.7, 5);
    expect(pf.captions.safeZone).toMatchObject({ top: 220, bottom: 400 });
  });

  it("writes the transcript in output time, one line per phrase", () => {
    const tm = TimeMap.fromKeepRanges([{ start: 0, end: 1.5 }, { start: 3, end: 6 }], 30, 6);
    const lines = outputTranscriptLines(
      [{ text: "So", start: 0.2, end: 0.4 }, { text: "this.", start: 0.4, end: 0.9 }, { text: "cut", start: 2, end: 2.4 }, { text: "Then", start: 3.1, end: 3.4 }, { text: "that.", start: 3.4, end: 3.9 }],
      tm,
    );
    expect(lines).toEqual(["[0.20–0.90] So this.", "[1.60–2.40] Then that."]);
  });
});

describe("clean render plan (trial reels)", () => {
  it("drops captions and words on screen, keeps cuts, look, pictures and audio", () => {
    const plan = fixturePlan();
    const withText = { ...plan, overlays: [...plan.overlays, { kind: "headline" as const, at: 0, dur: 2, text: "Title" }, { kind: "lower-third" as const, at: 1, dur: 2, text: "Name" }] };
    const clean = cleanPlan(withText as typeof plan);
    expect(clean.captions.style).toBe("none");
    expect(clean.overlays.some((o) => o.kind === "headline" || o.kind === "lower-third")).toBe(false);
    expect(clean.overlays.length).toBe(plan.overlays.filter((o) => o.kind !== "headline" && o.kind !== "lower-third").length);
    expect(clean.source).toEqual(plan.source);
    expect(clean.look).toEqual(plan.look);
    expect(clean.audio).toEqual(plan.audio);
    expect(parseEditPlan(clean)).toBeTruthy();
  });
});

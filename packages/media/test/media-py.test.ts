import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkMediaTools, ffprobe, media, mediaPy, MediaPyError } from "../src/index.ts";

const tools = checkMediaTools();
const haveTools = tools.every((t) => t.ok);
const dir = mkdtempSync(join(tmpdir(), "aos-media-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("checkMediaTools", () => {
  it("reports uv, ffmpeg and ffprobe with fixes", () => {
    expect(tools.map((t) => t.name)).toEqual(["uv", "ffmpeg", "ffprobe"]);
    for (const t of tools) if (!t.ok) expect(t.fix).toBeTruthy();
  });
});

describe("mediaPy runner", () => {
  it("explains a missing uv", async () => {
    await expect(mediaPy("version", {}, { uv: "/nonexistent/uv" })).rejects.toMatchObject({ code: expect.stringMatching(/uv_missing|spawn_failed/) });
  });

  it("explains a missing project", async () => {
    await expect(mediaPy("version", {}, { projectDir: join(dir, "nowhere") })).rejects.toMatchObject({ code: "project_missing", fix: expect.stringContaining("ATTENTIONOS_MEDIA_PY_DIR") });
  });

  it.skipIf(!haveTools)("runs a command, forwards progress and maps errors", { timeout: 120_000 }, async () => {
    const v = await mediaPy<{ version: string }>("version");
    expect(v.version).toMatch(/^\d+\.\d+\.\d+$/);
    const progress: string[] = [];
    const clip = await mediaPy<{ path: string; durationS: number; words: { text: string }[] }>(
      "synth",
      { output: join(dir, "clip.mp4"), width: 540, height: 960, script: [{ word: "hello", dur: 0.4 }, { pause: 0.8 }, { word: "there.", dur: 0.4 }] },
      { onProgress: (m) => progress.push(m) },
    );
    expect(clip.words.map((w) => w.text)).toEqual(["hello", "there."]);
    const probe = await ffprobe(clip.path);
    expect(probe.video).toMatchObject({ displayWidth: 540, displayHeight: 960, fps: 30 });
    expect(probe.audio?.codec).toBe("aac");
    const viaPy = await media.probe(clip.path);
    expect(viaPy.video?.displayHeight).toBe(960);
    const err = await media.probe(join(dir, "missing.mp4")).catch((e) => e);
    expect(err).toBeInstanceOf(MediaPyError);
    expect(err).toMatchObject({ code: "not_found", fix: expect.any(String) });
    const bad = await mediaPy("cut-plan", { transcript: {} }).catch((e) => e);
    expect(bad).toMatchObject({ code: "bad_input" });
    const em = await media.cutPlan({ audioPath: clip.path, transcript: { words: clip.words.map((w, i) => ({ text: w.text, start: i ? 1.2 : 0, end: i ? 1.6 : 0.4 })) } }, { onProgress: (m) => progress.push(m) });
    expect(em.status).toBe("review");
    expect(em.cuts.some((c) => c.kind === "silence")).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
  });

  it.skipIf(!haveTools)("times out cleanly", { timeout: 60_000 }, async () => {
    await expect(mediaPy("synth", { output: join(dir, "slow.mp4"), script: [{ word: "x", dur: 30 }] }, { timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
  });
});

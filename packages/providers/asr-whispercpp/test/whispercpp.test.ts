import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError, parseConfig, silentLogger } from "@attentionos/core";
import { checkMediaTools, mediaPy } from "@attentionos/media";
import { afterAll, describe, expect, it } from "vitest";
import { create, whisperSettings } from "../src/index.ts";

const haveTools = checkMediaTools().every((t) => t.ok);
const dir = mkdtempSync(join(tmpdir(), "aos-asr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const secrets = (env: Record<string, string>) => (n: string) => env[n];

describe("asr-whispercpp", () => {
  it("reads settings from the editing module and lets the env override the model", () => {
    const config = parseConfig({ modules: { editing: { settings: { asr: { model: "base.en", language: "en" } } } } });
    expect(whisperSettings(config, secrets({}))).toEqual({ model: "base.en", language: "en" });
    expect(whisperSettings(config, secrets({ ATTENTIONOS_ASR_MODEL: "medium" })).model).toBe("medium");
    expect(whisperSettings(parseConfig({}), secrets({})).model).toBe("small");
  });

  it.skipIf(!haveTools)("reports a missing model as unhealthy with a fix (no download)", { timeout: 60_000 }, async () => {
    const asr = create({ config: parseConfig({}), log: silentLogger, secret: secrets({ ATTENTIONOS_CACHE_DIR: join(dir, "empty-cache") }) });
    const h = await asr.health();
    expect(h.ok).toBe(false);
    expect(h.fix).toMatch(/doctor --fix/);
  });

  it.skipIf(!haveTools)("maps media-py errors to ProviderError codes", { timeout: 60_000 }, async () => {
    // The model would otherwise download itself on first use (500 MB); this test is about the "missing" error.
    process.env.ATTENTIONOS_AUTO_DOWNLOAD_MODELS = "0";
    const asr = create({ config: parseConfig({}), log: silentLogger, secret: secrets({ ATTENTIONOS_CACHE_DIR: join(dir, "empty-cache") }) });
    const missingFile = await asr.transcribe(join(dir, "nope.wav")).catch((e) => e);
    expect(missingFile).toBeInstanceOf(ProviderError);
    expect(missingFile.code).toBe("not_found");
    const clip = await mediaPy<{ path: string }>("synth", { output: join(dir, "a.wav"), video: false, script: [{ word: "x", dur: 0.5 }] });
    const noModel = await asr.transcribe(clip.path).catch((e) => e);
    expect(noModel).toBeInstanceOf(ProviderError);
    expect(noModel.code).toBe("unsupported");
    expect(noModel.message).toMatch(/not downloaded|not installed/);
  });

  it.skipIf(!haveTools)("returns core Transcript shape (stub engine via ATTENTIONOS_ASR_STUB fixture)", { timeout: 60_000 }, async () => {
    const clip = await mediaPy<{ path: string; words: { text: string; start: number; end: number }[] }>("synth", {
      output: join(dir, "b.wav"), video: false, script: [{ word: "Recorded", dur: 0.4 }, { word: "fixture.", dur: 0.4 }],
    });
    const stub = join(dir, "stub.json");
    writeFileSync(stub, JSON.stringify({ words: clip.words }));
    const asr = create({ config: parseConfig({}), log: silentLogger, secret: secrets({}), mediaPy: { env: { ATTENTIONOS_ASR_STUB: stub } } });
    const t = await asr.transcribe(clip.path);
    expect(t.words.map((w) => w.text)).toEqual(["Recorded", "fixture."]);
    expect(t.durationS).toBeGreaterThan(0.7);
    expect(t.language).toBe("en");
  });

  it.skipIf(!process.env.ATTENTIONOS_TEST_ASR)("transcribes with the real model (opt-in, downloads ~500 MB)", { timeout: 15 * 60_000 }, async () => {
    const asr = create({ config: parseConfig({}), log: silentLogger, secret: (n) => process.env[n] });
    await asr.downloadModel();
    expect((await asr.health()).ok).toBe(true);
    const clip = await mediaPy<{ path: string }>("synth", { output: join(dir, "real.wav"), video: false, script: [{ word: "a", dur: 0.6 }, { pause: 0.3 }, { word: "b", dur: 0.6 }] });
    const t = await asr.transcribe(clip.path, { language: "en" });
    for (const w of t.words) expect(w.end).toBeGreaterThanOrEqual(w.start);
  });
});

import { ProviderError, type Asr, type AttentionOSConfig, type Logger, type ProviderErrorCode, type ProviderHealth, type Transcript } from "@attentionos/core";
import { mediaPy, MediaPyError, type MediaPyOptions } from "@attentionos/media";
import { z } from "zod";

/**
 * `Asr` provider backed by whisper.cpp (the default ASR). Runs locally through the media-py sidecar
 * (`attentionos-media asr`), so nothing leaves the machine and there is no per-minute cost. Word timestamps are
 * always returned (the cut planner needs them).
 *
 * Settings (all optional), from `config.modules.editing.settings.asr`:
 *   { model: "small" | "base.en" | "medium" | ... | "/path/to/ggml-model.bin", language: "en", threads: 6 }
 * Secrets/env: ATTENTIONOS_ASR_MODEL overrides the model; ATTENTIONOS_CACHE_DIR moves the model cache.
 * The model (~500 MB for `small`) is fetched once with `attentionos doctor --fix`
 * (`attentionos-media models download`).
 */

export type CreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  /** Overrides for tests: media-py location, uv binary, timeouts. */
  mediaPy?: MediaPyOptions;
};

const settingsSchema = z
  .object({
    model: z.string().min(1).default("small"),
    language: z.string().min(2).optional(),
    threads: z.number().int().min(1).max(64).optional(),
  })
  .prefault({});

export type WhisperSettings = z.output<typeof settingsSchema>;

export function whisperSettings(config: AttentionOSConfig, secret: (n: string) => string | undefined): WhisperSettings {
  const raw = (config.modules.editing?.settings as { asr?: unknown } | undefined)?.asr ?? {};
  const parsed = settingsSchema.safeParse(raw);
  const s = parsed.success ? parsed.data : settingsSchema.parse({});
  const override = secret("ATTENTIONOS_ASR_MODEL");
  return override ? { ...s, model: override } : s;
}

const CODE_MAP: Record<string, ProviderErrorCode> = {
  not_found: "not_found",
  bad_input: "invalid_request",
  uv_missing: "unsupported",
  ffmpeg_missing: "unsupported",
  project_missing: "unsupported",
  model_missing: "unsupported",
  asr_engine_missing: "unsupported",
};

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof MediaPyError) {
    const msg = err.fix ? `${err.message} ${err.fix}` : err.message;
    return new ProviderError("whispercpp", CODE_MAP[err.code] ?? "upstream", msg, { vendorCode: err.code, raw: err.details });
  }
  return new ProviderError("whispercpp", "upstream", (err as Error)?.message ?? String(err));
}

type PyTranscript = { language: string; text: string; words: { text: string; start: number; end: number; confidence?: number }[]; durationS: number };

export interface WhisperAsr extends Asr {
  readonly id: "whispercpp";
  readonly settings: WhisperSettings;
  /** Downloads the configured model into the cache (one time, ~500 MB for `small`). */
  downloadModel(): Promise<{ path: string; status: string }>;
}

export function create(opts: CreateOptions): WhisperAsr {
  const settings = whisperSettings(opts.config, opts.secret);
  const cacheDir = opts.secret("ATTENTIONOS_CACHE_DIR");
  const modelName = settings.model.startsWith("whisper-") || settings.model.includes("/") || settings.model.includes("\\") ? settings.model : `whisper-${settings.model}`;
  const isPath = /[\\/]/.test(settings.model);
  const py = (o?: MediaPyOptions): MediaPyOptions => ({ ...opts.mediaPy, ...o });

  return {
    id: "whispercpp",
    settings,

    async health(): Promise<ProviderHealth> {
      try {
        if (isPath) return { ok: true, detail: `Using the whisper.cpp model at ${settings.model}` };
        const r = await mediaPy<{ paths: Record<string, { path: string; installed: boolean }> }>("models path", { name: modelName, ...(cacheDir ? { cacheDir } : {}) }, py({ timeoutMs: 120_000 }));
        const m = r.paths[modelName];
        if (!m?.installed) {
          return { ok: false, detail: `The speech model (${settings.model}) is not downloaded yet.`, fix: "Run `attentionos doctor --fix` to download it (about 500 MB, one time)." };
        }
        return { ok: true, detail: `whisper.cpp ${settings.model} is ready (runs on this machine, no cost per minute)` };
      } catch (err) {
        const e = toProviderError(err);
        return { ok: false, detail: e.message.replace(/^\[whispercpp\] \w+: /, ""), fix: err instanceof MediaPyError ? err.fix ?? "Run `attentionos doctor --fix`." : "Run `attentionos doctor --fix`." };
      }
    },

    async transcribe(localPath: string, o: { language?: string; prompt?: string } = {}): Promise<Transcript> {
      try {
        const res = await mediaPy<PyTranscript>(
          "asr",
          {
            path: localPath,
            engine: "whispercpp",
            model: settings.model,
            ...(o.language ?? settings.language ? { language: o.language ?? settings.language } : {}),
            ...(o.prompt ? { prompt: o.prompt } : {}),
            ...(settings.threads ? { threads: settings.threads } : {}),
            ...(cacheDir ? { cacheDir } : {}),
          },
          py({ onProgress: (m) => opts.log.debug("asr", { progress: m }) }),
        );
        return { language: res.language, text: res.text, durationS: res.durationS, words: res.words.map((w) => ({ text: w.text, start: w.start, end: w.end, ...(w.confidence != null ? { confidence: w.confidence } : {}) })) };
      } catch (err) {
        throw toProviderError(err);
      }
    },

    async downloadModel() {
      if (isPath) return { path: settings.model, status: "local file" };
      try {
        const r = await mediaPy<{ results: { path: string; status: string }[] }>("models download", { name: modelName, ...(cacheDir ? { cacheDir } : {}) }, py());
        return r.results[0]!;
      } catch (err) {
        throw toProviderError(err);
      }
    },
  };
}

export default create;

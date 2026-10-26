import { z } from "zod";
import type { EditMap } from "./edit-map.ts";
import type { EditPlan, Transcript } from "./edit-plan.ts";
import type { ProbeResult } from "./ffprobe.ts";
import { mediaPy, type MediaPyOptions } from "./media-py.ts";

/** JSON contracts of the media-py commands (see media-py/README.md). */

export type SilenceRun = { start: number; end: number };
export type SilenceMap = {
  strictDb: number;
  broadDb: number;
  gainDb: number;
  floorDb: number;
  speechDb: number;
  loudness: { integratedLufs: number; truePeakDbtp: number; lraLu: number } | null;
  strict: SilenceRun[];
  broad: SilenceRun[];
};

export type AsrRequest = {
  path: string;
  engine?: "whispercpp" | "parakeet" | "stub";
  model?: string;
  language?: string;
  prompt?: string;
  cacheDir?: string;
  threads?: number;
  stubWords?: { text: string; start: number; end: number }[];
};

export type PrepRequest = {
  source: string;
  workDir: string;
  fps?: number;
  proxy?: boolean;
  /** auto: link an edit-ready source instead of re-encoding it; encode: always make a proxy. */
  proxyMode?: "auto" | "encode";
  contactSheet?: boolean;
  asr?: Omit<AsrRequest, "path" | "threads" | "engine"> & { engine?: AsrRequest["engine"] | "none" };
  silence?: { strictDb?: number; broadDb?: number; strictMinS?: number; broadMinS?: number; targetLufs?: number | null };
  force?: boolean;
};

export type PrepResult = {
  source: string;
  workDir: string;
  probe: ProbeResult;
  proxy?: string;
  /** linked: the source was edit-ready and is used as is; encoded: a proxy was made. */
  proxyMode?: "linked" | "encoded";
  /** Faces, colour statistics (one low-rate decode); the renderer reads it instead of decoding again. */
  analysis?: string;
  audio: string;
  silenceMap: SilenceMap;
  contactSheet?: string;
  transcript?: Transcript & { durationS?: number };
  transcriptPath?: string;
};

export type CutPlanOptions = Partial<{
  fps: number;
  strictDb: number;
  broadDb: number;
  strictMinS: number;
  broadMinS: number;
  targetLufs: number | null;
  floorMarginDb: number;
  wordPadS: number;
  audioPadS: number;
  tailPadS: number;
  hookProtectS: number;
  protect: { start: number; end: number; reason: string }[];
  minKeepS: number;
  minCutS: number;
  retakes: boolean;
  retakeSimilarity: number;
  retakeWindowS: number;
  editNotes: boolean;
  editNotePhrases: string[];
  phraseGapS: number;
  maxPauseS: number;
  restarts: boolean;
  fillers: boolean;
  fillerWords: string[];
  guardedFillers: string[];
  fillerIslands: boolean;
  islandMaxS: number;
  sentencePauseS: number;
}>;

export type CutPlanRequest = { audioPath: string; sourcePath?: string; durationS?: number; transcript: { language?: string; words: Transcript["words"] }; options?: CutPlanOptions };

export type RenderRequest = {
  plan: EditPlan;
  /** assetId → local file. */
  assets: Record<string, { path: string; kind?: string }>;
  output: string;
  /** Re-use the same work dir across versions: unchanged parts are reused byte for byte. */
  workDir: string;
  preset?: string;
  chunkMaxS?: number;
  parallel?: number;
  seed?: number;
  preview?: boolean;
  /** Overrides plan.export.encoder. */
  encoder?: "auto" | "x264" | "hardware";
};

export type RenderChunk = { index: number; startFrame: number; endFrame: number; mode: string; hash: string; reused: boolean; encoder?: string };

export type RenderResult = {
  output: string;
  manifest: string;
  durationS: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  chunks: RenderChunk[];
  reusedChunks: number;
  speechStem: string;
  warnings: string[];
  elapsedS: number;
  encoder?: string;
  /** The mix's loudness after the render normalised it (finish then usually only verifies). */
  loudness?: { integratedLufs: number; truePeakDbtp: number; gainDb: number; limiterDb: number } | null;
};

export type FinishRequest = {
  input: string;
  output: string;
  loudness?: number;
  truePeak?: number;
  lra?: number;
  audioBitrate?: string;
  /** auto: copy when already on target (within tolerance); loudnorm: always run the two passes. */
  mode?: "auto" | "loudnorm";
  tolerance?: number;
};
export type FinishResult = {
  output: string;
  target: { integratedLufs: number; truePeakDbtp: number };
  before: { integratedLufs: number; truePeakDbtp: number; lraLu: number };
  after: { integratedLufs: number; truePeakDbtp: number; lraLu: number };
  linear: boolean;
  /** verified: already on target, streams copied; loudnorm: two-pass normalisation ran. */
  method?: "verified" | "loudnorm";
};

export const QC_CHECK_IDS = [
  "format", "duration", "first_frame", "black_frames", "freeze", "clipping", "loudness", "true_peak", "pauses", "dead_tail",
  "lead_in", "caption_safe_zone", "caption_contrast", "top_band", "top_band_contrast", "stream_hash",
] as const;

export const qcCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pass", "warn", "fail", "skip"]),
  detail: z.string(),
  fix: z.string().optional(),
  value: z.unknown().optional(),
  limit: z.unknown().optional(),
});
export const qcReportSchema = z.object({
  path: z.string(),
  passed: z.boolean(),
  summary: z.string(),
  checks: z.array(qcCheckSchema),
  measurements: z.record(z.string(), z.unknown()),
  fixes: z.array(z.string()),
});
export type QcReport = z.output<typeof qcReportSchema>;

export type QcRequest = {
  path: string;
  expect?: { w?: number; h?: number; fps?: number; codec?: string; audioCodec?: string; durationS?: number };
  loudness?: { target?: number; tolerance?: number; truePeakMax?: number };
  pauses?: { maxS?: number; p90TargetS?: number; maxLeadS?: number; maxTailS?: number };
  speechStem?: string;
  manifest?: string;
  previous?: { path: string; revision: "audio_only" | "video" | "full" };
  skip?: string[];
};

/** Typed wrappers. */
export const media = {
  probe: (path: string, o?: MediaPyOptions) => mediaPy<ProbeResult>("probe", { path }, o),
  prep: (req: PrepRequest, o?: MediaPyOptions) => mediaPy<PrepResult>("prep", req, o),
  asr: (req: AsrRequest, o?: MediaPyOptions) => mediaPy<Transcript & { durationS: number }>("asr", req, o),
  cutPlan: (req: CutPlanRequest, o?: MediaPyOptions) => mediaPy<EditMap>("cut-plan", req, o),
  render: (req: RenderRequest, o?: MediaPyOptions) => mediaPy<RenderResult>("render", req, o),
  finish: (req: FinishRequest, o?: MediaPyOptions) => mediaPy<FinishResult>("finish", req, o),
  qc: (req: QcRequest, o?: MediaPyOptions) => mediaPy<QcReport>("qc", req, o),
};

/** Plain-language one-liner for a QC report ("QC passed: 12 checks" / "QC found 2 problems: …"). */
export function describeQc(report: QcReport): string {
  const fails = report.checks.filter((c) => c.status === "fail");
  if (!fails.length) return `QC passed (${report.checks.filter((c) => c.status !== "skip").length} checks).`;
  return `QC found ${fails.length} problem${fails.length === 1 ? "" : "s"}: ${fails.map((c) => `${c.label.toLowerCase()} (${c.detail})`).join("; ")}.`;
}

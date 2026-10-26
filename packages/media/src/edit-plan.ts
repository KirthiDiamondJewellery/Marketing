import { z } from "zod";

/**
 * The EditPlan: one schema, two renderers (the cut engine in media-py, the opt-in motion engine).
 *
 * Time bases, stated once and enforced everywhere:
 * - `source.transcript.words` and `source.timeMap.keepRanges / dropped / protected` are SOURCE seconds.
 * - Everything else (`layout`, `overlays`, `broll`, `audio.sfx`, `camera`) is OUTPUT seconds, i.e. after the
 *   keep ranges are joined. Renderers quantise both to frames with `frame = Math.round(seconds * fps)`.
 *
 * The JSON Schema export of this schema (`editPlanJsonSchema()`, written to media-py by
 * `pnpm --filter @attentionos/media export-schema`) is what the Python sidecar validates against.
 */

export const PLAN_VERSION = 1 as const;

const seconds = z.number().finite().nonnegative();
const duration = z.number().finite().positive();
const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "use a #RRGGBB colour");

export const LAYOUT_MODES = ["full", "split", "fullVisual", "inset"] as const;
export const OVERLAY_KINDS = ["headline", "post-card", "screenshot", "logo", "lower-third", "chart"] as const;
export const SFX_KINDS = ["whoosh", "swipe", "pop", "riser", "click", "hit", "ding", "zoom", "impact", "glitch", "soft", "tick"] as const;
export const CAPTION_STYLES = ["bold-pop", "clean", "subtitle", "boxed", "serif", "none"] as const;
export const CAPTION_FONTS = ["montserrat", "geist", "instrument-serif", "caveat"] as const;
export const SAFE_ZONE_PRESETS = ["universal", "reels", "tiktok", "shorts"] as const;
export const PUNCH_IN_MODES = ["off", "emphasis", "sentences"] as const;
export const LOOK_GRADES = ["none", "pop", "vivid", "warm", "cool", "mono"] as const;
export const AUTO_SFX_MODES = ["off", "layout", "punches", "all"] as const;
export const DENOISE_MODES = ["auto", "off", "light", "strong"] as const;
export const ENCODERS = ["auto", "x264", "hardware"] as const;

export const wordSchema = z
  .object({
    text: z.string().min(1),
    start: seconds,
    end: seconds,
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((w) => w.end >= w.start, { message: "word end is before its start" });
export type Word = z.output<typeof wordSchema>;

export const transcriptSchema = z.object({
  language: z.string().default("en"),
  text: z.string().default(""),
  words: z.array(wordSchema).default([]),
  durationS: seconds.optional(),
});
export type Transcript = z.output<typeof transcriptSchema>;

export const rangeSchema = z
  .object({ start: seconds, end: seconds })
  .refine((r) => r.end > r.start, { message: "range end must be after its start" });
export type TimeRange = z.output<typeof rangeSchema>;

export const reasonRangeSchema = z
  .object({ start: seconds, end: seconds, reason: z.string().default(""), kind: z.string().optional() })
  .refine((r) => r.end > r.start, { message: "range end must be after its start" });

export const sourceMediaSchema = z.object({
  /** Local path of the footage the renderer reads (usually the prep proxy). */
  path: z.string().min(1),
  durationS: duration,
  /** `media_assets.id` of the raw footage, when known. */
  assetId: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
});

export const planTimeMapSchema = z.object({
  fps: z.number().int().min(1).max(120).default(30),
  /** SOURCE seconds that are played, in order. Usually copied from the approved edit map. */
  keepRanges: z.array(rangeSchema).min(1),
  dropped: z.array(reasonRangeSchema).default([]),
  protected: z.array(reasonRangeSchema).default([]),
});

export const pointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const visualRefSchema = z.object({
  assetId: z.string().min(1),
  /** Seconds into the visual at the segment's start. */
  in: seconds.default(0),
  loop: z.boolean().default(false),
});

export const chromaKeySchema = z.object({
  color: hex.default("#00FF00"),
  similarity: z.number().gt(0).max(1).default(0.3),
  blend: z.number().min(0).max(1).default(0.08),
});

export const insetSchema = z.object({
  scale: z.number().min(0.2).max(0.95).default(0.45),
  anchor: z.enum(["bottom-left", "bottom-right", "bottom-center"]).default("bottom-center"),
  /** Green-screen footage: key this colour out. */
  key: chromaKeySchema.optional(),
  /** Or: a matte video (white = keep) aligned with the source. */
  matteAssetId: z.string().optional(),
  /** Corner radius of the presenter window when there is no key or matte. */
  radius: z.number().int().min(0).max(200).default(36),
});

export const speakerSchema = z.object({
  position: z.enum(["top", "bottom"]).default("bottom"),
  focus: z.union([z.enum(["face", "center"]), pointSchema]).default("face"),
  /** Follow the face inside a shot when the speaker moves (smoothed, dead-zoned). Default true; false = one position per shot. */
  track: z.boolean().optional(),
});

export const layoutSegmentSchema = z.object({
  mode: z.enum(LAYOUT_MODES),
  start: seconds,
  dur: duration,
  fit: z.enum(["cover", "contain"]).default("cover"),
  visual: visualRefSchema.optional(),
  speaker: speakerSchema.prefault({}),
  inset: insetSchema.optional(),
  /** split: share of the height given to the top half. */
  splitRatio: z.number().min(0.3).max(0.7).default(0.5),
});
export type LayoutSegment = z.output<typeof layoutSegmentSchema>;

/**
 * UI-safe zone: margins (pixels, or fractions of the frame when ≤ 1) that captions and graphics never enter.
 * A preset fills any margin left out. `universal` is the intersection of IG Reels, TikTok and Shorts.
 */
export const SAFE_ZONE_MARGINS: Record<(typeof SAFE_ZONE_PRESETS)[number], { top: number; bottom: number; left: number; right: number }> = {
  universal: { top: 240, bottom: 440, left: 60, right: 160 },
  reels: { top: 220, bottom: 384, left: 60, right: 140 },
  tiktok: { top: 240, bottom: 440, left: 60, right: 160 },
  shorts: { top: 200, bottom: 420, left: 60, right: 150 },
};

export const safeZoneSchema = z.object({
  preset: z.enum(SAFE_ZONE_PRESETS).default("universal"),
  top: z.number().nonnegative().optional(),
  bottom: z.number().nonnegative().optional(),
  left: z.number().nonnegative().optional(),
  right: z.number().nonnegative().optional(),
});
export type SafeZone = z.output<typeof safeZoneSchema>;

export const captionsSchema = z.object({
  style: z.enum(CAPTION_STYLES).default("bold-pop"),
  /** Words drawn in the accent colour (case and punctuation insensitive). */
  emphasisWords: z.array(z.string()).default([]),
  safeZone: safeZoneSchema.prefault({}),
  position: z.enum(["lower", "middle", "seam"]).default("lower"),
  maxWords: z.number().int().min(1).max(10).optional(),
  case: z.enum(["upper", "as-is", "lower"]).optional(),
  font: z.enum(CAPTION_FONTS).optional(),
  /** ASR fixes for captions: { "clawed": "Claude" } (whole words, case insensitive). */
  replace: z.record(z.string(), z.string()).default({}),
  /** Colour of the word being spoken (the house style's brand colour). */
  activeColor: hex.optional(),
  /** Colour of emphasis words. */
  emphasisColor: hex.optional(),
  /** Size multiplier on the style's base size ("bigger captions" = 1.15). */
  scale: z.number().min(0.6).max(1.6).optional(),
});

export const overlaySchema = z.object({
  id: z.string().optional(),
  kind: z.enum(OVERLAY_KINDS),
  at: seconds,
  dur: duration,
  assetId: z.string().optional(),
  /** Claim ledger id backing what this overlay states (required for charts, post cards, screenshots and numbers). */
  evidenceId: z.string().optional(),
  text: z.string().optional(),
  subtext: z.string().optional(),
  position: z.enum(["top", "middle", "lower"]).optional(),
  /** Kind-specific fields: chart {labels, values, unit, highlight, source}; post-card {author, handle, stats, theme}; screenshot {source}; any {accent}. */
  props: z.record(z.string(), z.unknown()).default({}),
  /** Set when the overlay states a fact even without numbers. */
  claim: z.boolean().optional(),
});
export type Overlay = z.output<typeof overlaySchema>;

export const provenanceSchema = z.object({
  source: z.string().min(1),
  url: z.string().url().optional(),
  author: z.string().optional(),
  retrievedAt: z.string().optional(),
  note: z.string().optional(),
});

export const brollSchema = z.object({
  assetId: z.string().min(1),
  at: seconds,
  dur: duration,
  in: seconds.default(0),
  fit: z.enum(["cover", "contain"]).default("cover"),
  provenance: provenanceSchema,
  /** e.g. "CC0", "own footage", "CC-BY-4.0 (credit in caption)". */
  license: z.string().min(1),
});

export const sfxSchema = z.object({ kind: z.enum(SFX_KINDS), at: seconds, gainDb: z.number().min(-30).max(12).default(0) });

export const musicSchema = z.object({
  assetId: z.string().min(1),
  /** Level relative to speech. */
  gainDb: z.number().min(-40).max(0).default(-20),
  duck: z.boolean().default(true),
  license: z.string().optional(),
});

/** Voice clean-up before cutting; every level is measured, not guessed. All fields optional (engine defaults shown). */
export const voiceChainSchema = z.object({
  /** auto: FFT denoise sized from the speech-to-room ratio, skipped on clean rooms. */
  denoise: z.enum(DENOISE_MODES).optional(),
  deess: z.boolean().optional(),
  compress: z.boolean().optional(),
  /** High-pass for rumble, Hz (default 80). */
  highpassHz: z.number().min(0).max(300).optional(),
});

export const audioPlanSchema = z.object({
  sfx: z.array(sfxSchema).default([]),
  music: musicSchema.nullable().default(null),
  loudness: z.number().default(-14),
  truePeak: z.number().default(-1),
  voice: voiceChainSchema.optional(),
  /** Equal-power crossfade at every join so cuts never click (default 16 ms; 0 = a 4 ms fade only). */
  crossfadeMs: z.number().min(0).max(80).optional(),
  /** Sounds placed by code: on layout changes, on punch-ins, or both (default off). Plan `sfx` always play. */
  autoSfx: z.enum(AUTO_SFX_MODES).optional(),
});

export const cameraMoveSchema = z.object({
  kind: z.enum(["zoom", "push"]),
  at: seconds,
  dur: duration,
  scale: z.number().min(1).max(2).default(1.12),
  focus: pointSchema.optional(),
});

export const exportSchema = z.object({
  w: z.number().int().positive().default(1080),
  h: z.number().int().positive().default(1920),
  fps: z.number().int().min(1).max(120).default(30),
  codec: z.literal("h264").default("h264"),
  bitrate: z.string().regex(/^\d+(?:\.\d+)?[kM]$/, "like 12M or 8000k").default("12M"),
  audioBitrate: z.string().regex(/^\d+k$/).default("192k"),
  crf: z.number().int().min(10).max(35).default(18),
  /** auto/x264: libx264 (deterministic); hardware: VideoToolbox / NVENC / QSV when one works, else libx264. */
  encoder: z.enum(ENCODERS).optional(),
});

/**
 * Camera motion added by code in `full` segments (plan `camera` moves win while they run). Every field is optional;
 * engine defaults: jumpCutZoom 0.07 (alternate 1.0 / 1.07 at cuts), punchIns "emphasis", punchScale 0.06,
 * minGapS 4, hookPush true (a +4% push across the first shot), maxZoom 1.18.
 */
export const motionSchema = z.object({
  jumpCutZoom: z.number().min(0).max(0.25).optional(),
  punchIns: z.enum(PUNCH_IN_MODES).optional(),
  punchScale: z.number().min(0).max(0.25).optional(),
  minGapS: z.number().min(0.5).max(30).optional(),
  hookPush: z.boolean().optional(),
  maxZoom: z.number().min(1).max(2).optional(),
});
export type Motion = z.output<typeof motionSchema>;

/**
 * Automatic picture correction from measured statistics (levels, white balance) plus an optional grade. Defaults:
 * color "auto", strength 0.7, grade "none", sharpen "auto" (only when a reframed crop is upscaled).
 */
export const lookSchema = z.object({
  color: z.enum(["auto", "off"]).optional(),
  strength: z.number().min(0).max(1).optional(),
  grade: z.enum(LOOK_GRADES).optional(),
  sharpen: z.enum(["auto", "off", "on"]).optional(),
});
export type Look = z.output<typeof lookSchema>;

const planShape = z.object({
  version: z.literal(PLAN_VERSION).default(PLAN_VERSION),
  source: z.object({
    media: sourceMediaSchema,
    transcript: transcriptSchema.prefault({}),
    timeMap: planTimeMapSchema,
  }),
  /** Format template id from templates/formats (e.g. raw-talking-head). */
  format: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, "a format id like raw-talking-head"),
  layout: z.object({ segments: z.array(layoutSegmentSchema).default([]) }).prefault({}),
  captions: captionsSchema.prefault({}),
  overlays: z.array(overlaySchema).default([]),
  broll: z.array(brollSchema).default([]),
  audio: audioPlanSchema.prefault({}),
  camera: z.array(cameraMoveSchema).default([]),
  export: exportSchema.prefault({}),
  motion: motionSchema.optional(),
  look: lookSchema.optional(),
  meta: z
    .object({
      /** Brand Kit file the plan inherited taste from (path, never its contents). */
      houseStyle: z.string().optional(),
      notes: z.string().optional(),
      revision: z.number().int().positive().optional(),
    })
    .optional(),
});

/** Output duration (seconds) implied by the keep ranges, quantised to frames like the renderers do. */
export function planOutputDuration(plan: { source: { timeMap: { fps: number; keepRanges: { start: number; end: number }[] } } }): number {
  const { fps, keepRanges } = plan.source.timeMap;
  let frames = 0;
  let cursor = -1;
  for (const r of [...keepRanges].sort((a, b) => a.start - b.start)) {
    const a = Math.max(Math.round(r.start * fps), cursor);
    const b = Math.round(r.end * fps);
    if (b > a) frames += b - a;
    cursor = Math.max(cursor, b);
  }
  return frames / fps;
}

export const editPlanSchema = planShape.superRefine((p, ctx) => {
  const fps = p.source.timeMap.fps;
  const tol = 1 / fps + 1e-6;
  const ranges = [...p.source.timeMap.keepRanges].sort((a, b) => a.start - b.start);
  ranges.forEach((r, i) => {
    if (r.end > p.source.media.durationS + tol) {
      ctx.addIssue({ code: "custom", path: ["source", "timeMap", "keepRanges", i], message: `keep range ends at ${r.end}s, after the footage ends (${p.source.media.durationS}s)` });
    }
    const next = ranges[i + 1];
    if (next && next.start < r.end - tol) {
      ctx.addIssue({ code: "custom", path: ["source", "timeMap", "keepRanges", i + 1], message: `keep ranges overlap at ${next.start}s` });
    }
  });
  if (p.export.fps !== fps) {
    ctx.addIssue({ code: "custom", path: ["export", "fps"], message: `export fps (${p.export.fps}) must match the time map fps (${fps})` });
  }
  const D = planOutputDuration(p);
  const within = (path: (string | number)[], at: number, dur: number, label: string) => {
    if (at + dur > D + tol) ctx.addIssue({ code: "custom", path, message: `${label} runs to ${(at + dur).toFixed(2)}s, past the end of the video (${D.toFixed(2)}s)` });
  };
  const segs = p.layout.segments.map((s, i) => ({ s, i })).sort((a, b) => a.s.start - b.s.start);
  segs.forEach(({ s, i }, k) => {
    within(["layout", "segments", i], s.start, s.dur, `segment ${i + 1}`);
    const next = segs[k + 1];
    if (next && next.s.start < s.start + s.dur - tol) {
      ctx.addIssue({ code: "custom", path: ["layout", "segments", next.i], message: `segment ${next.i + 1} starts at ${next.s.start}s, inside segment ${i + 1}` });
    }
    if ((s.mode === "split" || s.mode === "fullVisual") && !s.visual) {
      ctx.addIssue({ code: "custom", path: ["layout", "segments", i, "visual"], message: `a ${s.mode} segment needs a visual (assetId of a screen recording or image)` });
    }
    if (s.mode === "inset" && !s.visual) {
      ctx.addIssue({ code: "custom", path: ["layout", "segments", i, "visual"], message: "an inset segment needs a visual behind the presenter" });
    }
  });
  p.overlays.forEach((o, i) => {
    within(["overlays", i], o.at, o.dur, `${o.kind} overlay ${i + 1}`);
    if ((o.kind === "screenshot" || o.kind === "logo") && !o.assetId) {
      ctx.addIssue({ code: "custom", path: ["overlays", i, "assetId"], message: `a ${o.kind} overlay needs an assetId` });
    }
    if ((o.kind === "headline" || o.kind === "lower-third") && !o.text) {
      ctx.addIssue({ code: "custom", path: ["overlays", i, "text"], message: `a ${o.kind} overlay needs text` });
    }
  });
  p.broll.forEach((b, i) => within(["broll", i], b.at, b.dur, `B-roll ${i + 1}`));
  p.camera.forEach((c, i) => within(["camera", i], c.at, c.dur, `camera move ${i + 1}`));
  p.audio.sfx.forEach((s, i) => {
    if (s.at > D + tol) ctx.addIssue({ code: "custom", path: ["audio", "sfx", i, "at"], message: `sound at ${s.at}s is after the end (${D.toFixed(2)}s)` });
  });
});

export type EditPlan = z.output<typeof editPlanSchema>;
export type EditPlanInput = z.input<typeof editPlanSchema>;

/** Safe-zone margins in pixels for a frame, with the preset filling anything left out. Fractions (≤ 1) scale. */
export function safeZoneMargins(zone: SafeZone, w = 1080, h = 1920): { top: number; bottom: number; left: number; right: number } {
  const base = SAFE_ZONE_MARGINS[zone.preset];
  const px = (v: number | undefined, fallback: number, dim: number, ref: number) =>
    v === undefined ? Math.round((fallback * dim) / ref) : v <= 1 ? Math.round(v * dim) : v;
  return {
    top: px(zone.top, base.top, h, 1920),
    bottom: px(zone.bottom, base.bottom, h, 1920),
    left: px(zone.left, base.left, w, 1080),
    right: px(zone.right, base.right, w, 1080),
  };
}

export type PlanIssue = { path: string; message: string };

/** Validates untrusted plan JSON (e.g. written by the Art Director). Issues are plain language with a JSON path. */
export function validateEditPlan(input: unknown): { ok: true; plan: EditPlan } | { ok: false; issues: PlanIssue[] } {
  const r = editPlanSchema.safeParse(input);
  if (r.success) {
    const plan = r.data;
    // Fill safe-zone margins from the preset so every consumer (renderers, preflight) sees explicit numbers.
    plan.captions.safeZone = { ...plan.captions.safeZone, ...safeZoneMargins(plan.captions.safeZone, plan.export.w, plan.export.h) };
    return { ok: true, plan };
  }
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(plan)", message: i.message })) };
}

export function parseEditPlan(input: unknown): EditPlan {
  const r = validateEditPlan(input);
  if (!r.ok) throw new EditPlanError(r.issues);
  return r.plan;
}

export class EditPlanError extends Error {
  constructor(public readonly issues: PlanIssue[]) {
    super(`The edit plan is not valid: ${issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join("; ")}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ""}`);
    this.name = "EditPlanError";
  }
}

/** JSON Schema (draft 2020-12) of what a plan author writes (defaults optional). */
export function editPlanJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(planShape, { io: "input", target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    ...schema,
    $id: "urn:attentionos:schema:edit-plan",
    title: "AttentionOS EditPlan",
    description:
      "One plan, two renderers. SOURCE seconds: source.transcript.words and source.timeMap.*; OUTPUT seconds: layout, overlays, broll, audio.sfx, camera. Generated from packages/media/src/edit-plan.ts; do not edit by hand.",
  };
}

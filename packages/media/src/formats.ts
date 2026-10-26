import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EditMap } from "./edit-map.ts";
import {
  CAPTION_FONTS,
  CAPTION_STYLES,
  LAYOUT_MODES,
  lookSchema,
  motionSchema,
  OVERLAY_KINDS,
  SAFE_ZONE_PRESETS,
  voiceChainSchema,
  type EditPlanInput,
  type Transcript,
} from "./edit-plan.ts";

/**
 * Format templates (`templates/formats/<id>/format.json` + `shoot.md`): layout defaults, caption style, overlay
 * slots, pacing rules, B-roll budget and the evidence behind each choice. The Art Director plans from one; the
 * daily brief shows its shoot directions.
 */

const range = z.tuple([z.number().nonnegative(), z.number().positive()]);

export const formatSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/),
  version: z.literal(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  /** When to pick this format (plain language, shown to the planner and in the daily brief). */
  bestFor: z.array(z.string()).min(1),
  /** What the user must film for it to work. */
  needs: z.array(z.string()).default([]),
  layout: z.object({
    default: z.enum(LAYOUT_MODES),
    /** Modes the planner may use, with a plain-language rule each. */
    modes: z.array(z.object({ mode: z.enum(LAYOUT_MODES), use: z.string() })).min(1),
    /** Share of fullVisual among middle segments (preflight layout-ratio gate). */
    fullVisualShare: z.object({ min: z.number().min(0).max(1).optional(), max: z.number().min(0).max(1).optional() }).optional(),
    splitRatio: z.number().min(0.3).max(0.7).optional(),
    inset: z.object({ scale: z.number().min(0.2).max(0.95), anchor: z.enum(["bottom-left", "bottom-right", "bottom-center"]), key: z.boolean().default(false) }).optional(),
    /** Change the visual at least this often (seconds), when visuals are used. */
    visualChangeEveryS: range.optional(),
  }),
  captions: z.object({
    style: z.enum(CAPTION_STYLES),
    position: z.enum(["lower", "middle", "seam"]),
    safeZone: z.enum(SAFE_ZONE_PRESETS).default("universal"),
    maxWords: z.number().int().min(1).max(10).optional(),
    case: z.enum(["upper", "as-is", "lower"]).optional(),
    font: z.enum(CAPTION_FONTS).optional(),
    emphasisPerLine: range.default([0, 2]),
    /** Size multiplier on the style's base size. */
    scale: z.number().min(0.6).max(1.6).optional(),
  }),
  overlaySlots: z.array(
    z.object({
      kind: z.enum(OVERLAY_KINDS),
      when: z.string(),
      max: z.number().int().nonnegative(),
      /** Overlays that state facts must carry an evidenceId from the script's claim ledger. */
      evidenceRequired: z.boolean().default(false),
    }),
  ),
  pacing: z.object({
    targetLengthS: range,
    /** The whole claim must land by this second. */
    hookBy: z.number().positive().default(3),
    /** QC fails any pause longer than this (seconds). */
    maxPauseS: z.number().positive().default(0.15),
    p90PauseS: z.number().positive().default(0.1),
    cut: z
      .object({
        strictDb: z.number().default(-42),
        broadDb: z.number().default(-35),
        wordPadS: z.number().nonnegative().default(0.05),
        hookProtectS: z.number().nonnegative().default(0.6),
        minKeepS: z.number().nonnegative().default(0.2),
        retakes: z.boolean().default(true),
        editNotes: z.boolean().default(true),
        /** Restarts and stutters inside a sentence keep the last attempt (engine default true). */
        restarts: z.boolean().optional(),
        /** "um"/"uh" always; "like", "you know", "I mean" only when set off by commas or pauses (engine default true). */
        fillers: z.boolean().optional(),
        /** Short wordless sounds between pauses (an "um" the ASR left out, a breath) are cut (engine default true). */
        fillerIslands: z.boolean().optional(),
        /** Quiet kept after a full stop so the delivery breathes (engine default 0.10 s; stays under maxPauseS). */
        sentencePauseS: z.number().min(0).max(0.5).optional(),
      })
      .prefault({}),
    notes: z.array(z.string()).default([]),
  }),
  audio: z.object({
    sfx: z.enum(["none", "sparse", "beats"]),
    music: z.enum(["none", "optional", "bed"]),
    notes: z.array(z.string()).default([]),
    /** Voice clean-up overrides (denoise, de-ess, compressor, high-pass). */
    voice: voiceChainSchema.optional(),
  }),
  camera: z.object({ punchIns: z.boolean(), push: z.boolean() }),
  /** Motion defaults for this format (jump-cut zoom, punch-ins, hook push); `camera` switches them off wholesale. */
  motion: motionSchema.optional(),
  /** Picture defaults (automatic colour, grade, sharpening). */
  look: lookSchema.optional(),
  broll: z.object({ stills: z.number().int().min(0).max(8), loops: z.number().int().min(0).max(6), notes: z.array(z.string()).default([]) }),
  /** Why the defaults are what they are, with how strong the evidence is. Plain language, no names. */
  evidence: z.array(z.object({ choice: z.string(), why: z.string(), strength: z.enum(["strong", "moderate", "weak"]) })).min(1),
});
export type FormatTemplate = z.output<typeof formatSchema> & { shoot: string; dir: string };

const HERE = dirname(fileURLToPath(import.meta.url));

export function formatsDir(override?: string): string {
  return override ?? process.env.ATTENTIONOS_FORMATS_DIR ?? resolve(HERE, "../../../templates/formats");
}

export class FormatError extends Error {
  constructor(message: string, public readonly fix?: string) {
    super(message);
    this.name = "FormatError";
  }
}

export function listFormats(dir = formatsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "format.json")))
    .map((d) => d.name)
    .sort();
}

export function loadFormat(id: string, dir = formatsDir()): FormatTemplate {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(id)) throw new FormatError(`"${id}" is not a format id.`, `Use one of: ${listFormats(dir).join(", ")}.`);
  const fdir = join(dir, id);
  const file = join(fdir, "format.json");
  if (!existsSync(file)) throw new FormatError(`There is no format called ${id}.`, `Use one of: ${listFormats(dir).join(", ")}.`);
  const parsed = formatSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new FormatError(`${id}/format.json is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  if (parsed.data.id !== id) throw new FormatError(`${id}/format.json says its id is ${parsed.data.id}.`);
  const shootPath = join(fdir, "shoot.md");
  return { ...parsed.data, shoot: existsSync(shootPath) ? readFileSync(shootPath, "utf8") : "", dir: fdir };
}

export function formatJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(formatSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>),
    $id: "urn:attentionos:schema:format",
    title: "AttentionOS format template",
    description: "templates/formats/<id>/format.json. Generated from packages/media/src/formats.ts; do not edit by hand.",
  };
}

/** Cut-plan options a format implies (merged under the workspace's module settings). */
export function formatCutOptions(f: FormatTemplate) {
  const c = f.pacing.cut;
  return {
    strictDb: c.strictDb,
    broadDb: c.broadDb,
    wordPadS: c.wordPadS,
    hookProtectS: c.hookProtectS,
    minKeepS: c.minKeepS,
    retakes: c.retakes,
    editNotes: c.editNotes,
    maxPauseS: f.pacing.maxPauseS,
    ...(c.restarts !== undefined ? { restarts: c.restarts } : {}),
    ...(c.fillers !== undefined ? { fillers: c.fillers } : {}),
    ...(c.fillerIslands !== undefined ? { fillerIslands: c.fillerIslands } : {}),
    ...(c.sentencePauseS !== undefined ? { sentencePauseS: Math.min(c.sentencePauseS, f.pacing.maxPauseS - 0.02) } : {}),
  };
}

/** The plan's motion block a format implies: `camera.punchIns: false` turns off every automatic zoom, `camera.push:
 * false` the hook push; `motion` fine-tunes the rest. */
export function formatMotion(f: FormatTemplate): z.output<typeof motionSchema> {
  return {
    ...(f.camera.punchIns ? {} : { jumpCutZoom: 0, punchIns: "off" as const }),
    ...(f.camera.push ? {} : { hookPush: false }),
    ...(f.motion ?? {}),
  };
}

/** Code-placed sound effects a format implies: none → off, sparse → on layout changes, beats → layout and punch-ins. */
export function formatAutoSfx(f: FormatTemplate): "off" | "layout" | "all" {
  return f.audio.sfx === "none" ? "off" : f.audio.sfx === "sparse" ? "layout" : "all";
}

/** The first spoken sentence, trimmed to a headline (at most 8 words), for the frame-1 hook card. */
export function hookHeadline(words: { text: string }[], maxWords = 8): string | null {
  const out: string[] = [];
  for (const w of words) {
    const t = w.text.trim();
    if (!t) continue;
    out.push(t);
    if (/[.?!]["')\]]*$/.test(t) || out.length >= maxWords) break;
  }
  const text = out.join(" ").replace(/[,;:]+$/, "").trim();
  return text.split(/\s+/).length >= 2 ? text : null;
}

/**
 * A starting plan from the format defaults, the approved edit map and the transcript: one segment in the default
 * layout, captions in the format's style, no overlays. The Art Director edits this instead of writing a plan from
 * nothing, which keeps the LLM's output (and cost) small.
 */
export function draftPlan(args: {
  format: FormatTemplate;
  editMap: EditMap;
  transcript: Pick<Transcript, "language" | "words">;
  source: { path: string; durationS: number; assetId?: string };
  houseStyle?: string;
}): EditPlanInput {
  const { format: f, editMap } = args;
  const fps = editMap.fps;
  const keepFrames = editMap.keepRanges.reduce((n, r) => n + (Math.round(r.end * fps) - Math.round(r.start * fps)), 0);
  const D = keepFrames / fps;
  const mode = f.layout.default === "full" || f.layout.default === "inset" ? f.layout.default : "full";
  return {
    version: 1,
    format: f.id,
    source: {
      media: { path: args.source.path, durationS: args.source.durationS, ...(args.source.assetId ? { assetId: args.source.assetId } : {}) },
      transcript: { language: args.transcript.language ?? "en", words: args.transcript.words },
      timeMap: { fps, keepRanges: editMap.keepRanges, dropped: editMap.cuts.map((c) => ({ start: c.start, end: c.end, reason: c.reason, kind: c.kind })), protected: editMap.protected },
    },
    layout: { segments: [{ mode: mode === "inset" ? "full" : mode, start: 0, dur: D }] },
    captions: {
      style: f.captions.style,
      position: f.captions.position,
      safeZone: { preset: f.captions.safeZone },
      emphasisWords: [],
      ...(f.captions.maxWords ? { maxWords: f.captions.maxWords } : {}),
      ...(f.captions.case ? { case: f.captions.case } : {}),
      ...(f.captions.font ? { font: f.captions.font } : {}),
      ...(f.captions.scale ? { scale: f.captions.scale } : {}),
    },
    overlays: hookOverlay(f, editMap, args.transcript.words, D),
    broll: [],
    audio: {
      sfx: [],
      music: null,
      loudness: -14,
      truePeak: -1,
      autoSfx: formatAutoSfx(f),
      ...(f.audio.voice ? { voice: f.audio.voice } : {}),
    },
    camera: [],
    export: { w: 1080, h: 1920, fps, codec: "h264" },
    motion: formatMotion(f),
    ...(f.look ? { look: f.look } : {}),
    ...(args.houseStyle ? { meta: { houseStyle: args.houseStyle } } : {}),
  };
}

/** A frame-1 hook headline drafted from the first kept sentence when the format has a headline slot (the planner
 * rewrites or removes it). */
function hookOverlay(f: FormatTemplate, editMap: EditMap, words: { text: string; start: number; end: number }[], D: number): EditPlanInput["overlays"] {
  if (!f.overlaySlots.some((s) => s.kind === "headline" && s.max > 0) || D < 1) return [];
  const first = editMap.keepRanges[0]?.start ?? 0;
  const kept = words.filter((w) => editMap.keepRanges.some((r) => w.start >= r.start - 0.05 && w.end <= r.end + 0.05) && w.start >= first);
  const text = hookHeadline(kept);
  return text ? [{ kind: "headline", at: 0, dur: Math.min(2.5, D), text }] : [];
}

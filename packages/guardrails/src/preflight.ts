import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ClaimEntry } from "./claims.ts";
import { IssueCollector, type ValidationResult } from "./issues.ts";
import { extractNumbers } from "./numbers.ts";

/**
 * Edit preflight gates at `plan | render | final`.
 *
 * The canonical EditPlan zod schema lives in `@attentionos/media` (owned by the editing slice). This gate
 * accepts any object with the documented fields below (structural typing) and checks them itself, so the
 * two packages don't need to import each other.
 */

export type PreflightStage = "plan" | "render" | "final";
export type LayoutMode = "full" | "split" | "fullVisual" | "inset";

export type PreflightEditPlan = {
  source: {
    /** Path or media asset id of the source footage. */
    media: string;
    transcript?: { words?: { text: string; start: number; end: number }[] };
    timeMap?: { keepRanges?: ({ start: number; end: number } | [number, number])[] };
  };
  format: string;
  /** Either `{ segments: [...] }` or the segments array itself. Times are OUTPUT seconds. */
  layout: { segments: LayoutSegment[] } | LayoutSegment[];
  captions?: { style?: string; emphasisWords?: string[]; safeZone?: SafeZone };
  overlays?: Overlay[];
  broll?: { assetId: string; at: number; dur: number; provenance?: unknown; license?: string | null }[];
  audio?: { sfx?: { kind: string; at: number }[]; music?: { assetId: string; gainDb?: number } | null; loudness?: number; truePeak?: number };
  camera?: { kind?: string; at: number; dur: number }[];
  export?: { w: number; h: number; fps: number; codec?: string; bitrate?: number | string };
  /** Output duration in seconds; derived from keepRanges or the layout when absent. */
  durationS?: number;
};

export type LayoutSegment = { mode: LayoutMode; start: number; dur: number; fit?: string };
export type Overlay = {
  kind: string;
  at: number;
  dur: number;
  assetId?: string | null;
  evidenceId?: string | null;
  text?: string | null;
  /** Set true when the overlay states a fact; numbers in `text` and kind "chart" count as claims too. */
  claim?: boolean;
};
/** Fractions of the frame (0 to 1) or pixels (> 1). */
export type SafeZone = { top: number; bottom: number; left?: number; right?: number };

export type SignoffKind = "edit_map" | "plan" | "playback" | "claims";
export type Signoff = { kind: SignoffKind; by: string; at: string };

export type PreflightContext = {
  /** Resolves relative paths. */
  baseDir?: string;
  /** media asset id → uri (local path). Ids not in the map are treated as paths. */
  assets?: Record<string, { uri: string }>;
  /** Override for existence checks (tests, remote storage). */
  fileExists?: (path: string) => boolean;
  /** The script's claim ledger; overlay evidenceIds must resolve to a PASS entry by id. */
  claimLedger?: readonly ClaimEntry[];
  signoffs?: readonly Signoff[];
  /** Sign-offs needed per stage. */
  requiredSignoffs?: Partial<Record<PreflightStage, readonly SignoffKind[]>>;
  /** Template-specific share of fullVisual among middle segments, e.g. { min: 0.333, max: 0.5 }. */
  fullVisualShare?: { min?: number; max?: number };
  /** Minimum caption safe zone as fractions of the frame. */
  minSafeZone?: { top?: number; bottom?: number; side?: number };
  /** render/final: paths of rendered segment files that must exist. */
  renderOutputs?: readonly string[];
  /** final: the exported file and its probe (from ffprobe / media-py). */
  exportPath?: string;
  exportProbe?: { width: number; height: number; fps: number; durationS?: number };
};

export const DEFAULT_REQUIRED_SIGNOFFS: Record<PreflightStage, readonly SignoffKind[]> = {
  plan: ["edit_map"],
  render: ["edit_map", "plan"],
  final: ["edit_map", "plan", "playback", "claims"],
};
export const DEFAULT_MIN_SAFE_ZONE = { top: 0.08, bottom: 0.15, side: 0.04 };
const CLAIM_KINDS = new Set(["chart", "post-card", "screenshot"]);
const SIGNOFF_LABEL: Record<SignoffKind, string> = {
  edit_map: "the silence cut (edit map)",
  plan: "the edit plan",
  playback: "a full playback review",
  claims: "the factual claims review",
};

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function preflight(stage: PreflightStage, plan: unknown, ctx: PreflightContext = {}): ValidationResult {
  const c = new IssueCollector();
  if (!plan || typeof plan !== "object") {
    c.error("preflight.no_plan", "There is no edit plan to check.", { fix: "Write plan.json from a format template first." });
    return c.result();
  }
  const p = plan as Partial<PreflightEditPlan>;
  const exists = (ref: string) => {
    const uri = ctx.assets?.[ref]?.uri ?? ref;
    const path = isAbsolute(uri) || /^[a-z]+:\/\//i.test(uri) ? uri : resolve(ctx.baseDir ?? process.cwd(), uri);
    return (ctx.fileExists ?? existsSync)(path);
  };

  // --- structure ---
  if (!p.source || typeof p.source.media !== "string" || !p.source.media) c.error("preflight.source_missing", "The plan has no source media.", { path: "source.media", fix: "Point source.media at the raw footage or its asset id." });
  if (typeof p.format !== "string" || !p.format) c.error("preflight.format_missing", "The plan has no format template.", { path: "format", fix: "Set format to a template id from templates/formats." });
  const segments: LayoutSegment[] = Array.isArray(p.layout) ? p.layout : Array.isArray(p.layout?.segments) ? p.layout.segments : [];
  if (segments.length === 0) c.error("preflight.layout_missing", "The plan has no layout segments.", { path: "layout", fix: "Add at least one segment covering the whole video." });
  const exp = p.export;
  if (!exp || !num(exp.w) || !num(exp.h) || !num(exp.fps)) c.error("preflight.export_missing", "The plan has no export settings (w, h, fps).", { path: "export", fix: "Set export to { w: 1080, h: 1920, fps: 30 }." });

  // Duration
  let duration = num(p.durationS) ? p.durationS : undefined;
  const keep = p.source?.timeMap?.keepRanges;
  if (duration === undefined && Array.isArray(keep) && keep.length > 0) {
    duration = keep.reduce((sum, r) => sum + (Array.isArray(r) ? r[1] - r[0] : r.end - r.start), 0);
  }
  if (duration === undefined && segments.length > 0) duration = Math.max(...segments.map((s) => s.start + s.dur));
  const D = duration ?? 0;

  // --- layout ---
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  sorted.forEach((s, i) => {
    const path = `layout.segments[${segments.indexOf(s)}]`;
    if (!["full", "split", "fullVisual", "inset"].includes(s.mode)) c.error("preflight.layout_mode", `Segment ${i + 1} has an unknown mode "${String(s.mode)}".`, { path, fix: "Use full, split, fullVisual or inset." });
    if (!num(s.start) || !num(s.dur) || s.start < 0 || s.dur <= 0) {
      c.error("preflight.layout_timing", `Segment ${i + 1} has an invalid start or duration.`, { path, fix: "Start must be 0 or more and duration above 0, in output seconds." });
      return;
    }
    const next = sorted[i + 1];
    if (next && num(next.start) && s.start + s.dur > next.start + 1e-3) c.error("preflight.layout_overlap", `Segments ${i + 1} and ${i + 2} overlap (${(s.start + s.dur).toFixed(2)}s > ${next.start.toFixed(2)}s).`, { path, fix: "Make each segment end where the next one starts." });
    if (next && num(next.start) && next.start - (s.start + s.dur) > 0.05) c.warn("preflight.layout_gap", `There is a ${(next.start - (s.start + s.dur)).toFixed(2)}s gap after segment ${i + 1}.`, { path, fix: "Close the gap so every frame has a layout." });
    if (D > 0 && s.start + s.dur > D + 0.05) c.error("preflight.layout_past_end", `Segment ${i + 1} runs past the end of the video (${(s.start + s.dur).toFixed(2)}s > ${D.toFixed(2)}s).`, { path });
  });
  if (sorted[0] && sorted[0].start > 0.001) c.error("preflight.layout_start", `The first segment starts at ${sorted[0].start}s; the layout must start at 0.`, { path: "layout", fix: "Start the first segment at frame 0." });
  if (ctx.fullVisualShare && sorted.length > 2) {
    const middle = sorted.slice(1, -1);
    const share = middle.filter((s) => s.mode === "fullVisual").length / middle.length;
    const { min, max } = ctx.fullVisualShare;
    if (min !== undefined && share < min) c.error("preflight.layout_ratio", `Full-visual segments are ${(share * 100).toFixed(0)}% of the middle; this format needs at least ${(min * 100).toFixed(0)}%.`, { path: "layout", fix: "Turn more middle segments into full visuals." });
    if (max !== undefined && share > max) c.warn("preflight.layout_ratio", `Full-visual segments are ${(share * 100).toFixed(0)}% of the middle; this format aims for at most ${(max * 100).toFixed(0)}%.`, { path: "layout", fix: "Bring the speaker back on screen more often." });
  }
  if (exp && num(exp.w) && num(exp.h) && Math.abs(exp.w / exp.h - 9 / 16) > 0.001) {
    c.error("preflight.aspect", `Export is ${exp.w}x${exp.h}, which isn't 9:16.`, { path: "export", fix: "Export at 1080x1920." });
  }

  // --- captions safe zone ---
  const sz = p.captions?.safeZone;
  if (p.captions && !sz) c.error("preflight.safe_zone_missing", "Captions have no safe zone.", { path: "captions.safeZone", fix: "Set captions.safeZone (top, bottom, left, right) from house-style.md." });
  if (sz) {
    const w = exp?.w ?? 1080;
    const h = exp?.h ?? 1920;
    const frac = (v: number | undefined, dim: number) => (v === undefined ? undefined : v > 1 ? v / dim : v);
    const top = frac(sz.top, h);
    const bottom = frac(sz.bottom, h);
    const left = frac(sz.left, w);
    const right = frac(sz.right, w);
    const min = { ...DEFAULT_MIN_SAFE_ZONE, ...ctx.minSafeZone };
    for (const [name, v, dimLabel] of [["top", top, "height"], ["bottom", bottom, "height"]] as const) {
      if (v === undefined || !num(v) || v < 0) c.error("preflight.safe_zone_value", `Safe zone ${name} is missing or negative.`, { path: `captions.safeZone.${name}` });
      else if (v < min[name]) c.error("preflight.safe_zone_small", `Safe zone ${name} is ${(v * 100).toFixed(1)}% of the frame ${dimLabel}; captions there sit under the app's buttons. Minimum is ${(min[name] * 100).toFixed(0)}%.`, { path: `captions.safeZone.${name}`, fix: `Raise it to at least ${Math.ceil(min[name] * h)}px.` });
    }
    for (const [name, v] of [["left", left], ["right", right]] as const) {
      if (v !== undefined && v < min.side) c.error("preflight.safe_zone_small", `Safe zone ${name} is ${(v * 100).toFixed(1)}% of the frame width; minimum is ${(min.side * 100).toFixed(0)}%.`, { path: `captions.safeZone.${name}`, fix: `Raise it to at least ${Math.ceil(min.side * w)}px.` });
    }
    if (top !== undefined && bottom !== undefined && top + bottom >= 0.8) c.error("preflight.safe_zone_overlap", "Safe zone top and bottom leave less than 20% of the frame for captions.", { path: "captions.safeZone", fix: "Shrink the margins." });
  }

  // --- overlays, b-roll, music: assets exist, claims have evidence, timing inside the video ---
  const ledger = ctx.claimLedger ?? [];
  const byId = new Map(ledger.filter((e) => e.id).map((e) => [e.id!, e]));
  (p.overlays ?? []).forEach((o, i) => {
    const path = `overlays[${i}]`;
    if (o.assetId && !exists(o.assetId)) c.error("preflight.asset_missing", `Overlay ${i + 1} (${o.kind}) uses "${o.assetId}", which isn't on disk.`, { path: `${path}.assetId`, fix: "Fetch or render the asset, or remove the overlay." });
    const hasClaim = o.claim === true || CLAIM_KINDS.has(o.kind) || (o.text ? extractNumbers(o.text).length > 0 : false);
    if (hasClaim) {
      if (!o.evidenceId) {
        c.error("preflight.evidence_missing", `Overlay ${i + 1} (${o.kind}${o.text ? `: "${o.text.slice(0, 40)}"` : ""}) shows a claim but has no evidenceId.`, { path: `${path}.evidenceId`, fix: "Set evidenceId to the id of the PASS claim in the script's claim ledger." });
      } else {
        const entry = byId.get(o.evidenceId);
        if (!entry) c.error("preflight.evidence_unknown", `Overlay ${i + 1} points at evidence "${o.evidenceId}", which isn't in the claim ledger.`, { path: `${path}.evidenceId`, fix: "Use the id of a claim in the approved script's ledger." });
        else if (entry.verdict !== "PASS") c.error("preflight.evidence_not_pass", `Overlay ${i + 1} points at claim "${o.evidenceId}", which is marked ${entry.verdict}.`, { path: `${path}.evidenceId`, fix: "Remove the overlay or point it at a PASS claim." });
      }
    }
    checkTiming(c, o.at, o.dur, D, path, `Overlay ${i + 1}`);
  });
  (p.broll ?? []).forEach((b, i) => {
    const path = `broll[${i}]`;
    if (!exists(b.assetId)) c.error("preflight.asset_missing", `B-roll ${i + 1} uses "${b.assetId}", which isn't on disk.`, { path: `${path}.assetId`, fix: "Fetch the clip or remove it." });
    if (!b.license) c.error("preflight.broll_license", `B-roll ${i + 1} has no license recorded.`, { path: `${path}.license`, fix: "Record the license (e.g. CC0, own footage) or swap the clip." });
    checkTiming(c, b.at, b.dur, D, path, `B-roll ${i + 1}`);
  });
  if (p.audio?.music?.assetId && !exists(p.audio.music.assetId)) c.error("preflight.asset_missing", `Music "${p.audio.music.assetId}" isn't on disk.`, { path: "audio.music.assetId" });
  (p.audio?.sfx ?? []).forEach((s, i) => {
    if (!num(s.at) || s.at < 0 || (D > 0 && s.at > D)) c.error("preflight.timing", `Sound effect ${i + 1} is at ${s.at}s, outside the video (0 to ${D.toFixed(2)}s).`, { path: `audio.sfx[${i}].at` });
  });
  (p.camera ?? []).forEach((m, i) => checkTiming(c, m.at, m.dur, D, `camera[${i}]`, `Camera move ${i + 1}`));
  if (p.audio) {
    if (num(p.audio.loudness) && Math.abs(p.audio.loudness - -14) > 1) c.error("preflight.loudness", `Loudness target is ${p.audio.loudness} LUFS; it must be -14.`, { path: "audio.loudness", fix: "Set loudness to -14." });
    if (num(p.audio.truePeak) && p.audio.truePeak > -1) c.error("preflight.true_peak", `True peak is ${p.audio.truePeak} dBTP; it must be -1 or lower.`, { path: "audio.truePeak", fix: "Set truePeak to -1." });
  }
  if (p.source?.media && !exists(p.source.media)) c.error("preflight.asset_missing", `Source footage "${p.source.media}" isn't on disk.`, { path: "source.media", fix: "Check the path, or re-import the footage." });

  // --- render / final outputs ---
  if (stage !== "plan") {
    for (const out of ctx.renderOutputs ?? []) {
      if (!exists(out)) c.error("preflight.render_missing", `Rendered segment "${out}" is missing.`, { path: "renderOutputs", fix: "Render it before moving on." });
    }
  }
  if (stage === "final") {
    if (!ctx.exportPath || !exists(ctx.exportPath)) c.error("preflight.export_file_missing", "The final export file is missing.", { path: "exportPath", fix: "Render the final export, then run the final preflight again." });
    const probe = ctx.exportProbe;
    if (!probe) c.error("preflight.export_unprobed", "The final export hasn't been probed.", { path: "exportProbe", fix: "Probe the file (width, height, fps) and pass the result." });
    else {
      const w = exp?.w ?? 1080;
      const h = exp?.h ?? 1920;
      const fps = exp?.fps ?? 30;
      if (probe.width !== w || probe.height !== h) c.error("preflight.export_size", `The export is ${probe.width}x${probe.height}; the plan says ${w}x${h}.`, { path: "exportProbe", fix: `Re-export at ${w}x${h}.` });
      if (Math.abs(probe.fps - fps) > 0.01) c.error("preflight.export_fps", `The export runs at ${probe.fps}fps; the plan says ${fps}fps.`, { path: "exportProbe", fix: `Re-export at ${fps}fps.` });
      if (probe.durationS !== undefined && D > 0 && Math.abs(probe.durationS - D) > 0.5) c.warn("preflight.export_duration", `The export is ${probe.durationS.toFixed(2)}s; the plan is ${D.toFixed(2)}s.`, { path: "exportProbe" });
    }
  }

  // --- human sign-offs ---
  const need = ctx.requiredSignoffs?.[stage] ?? DEFAULT_REQUIRED_SIGNOFFS[stage];
  const have = new Set((ctx.signoffs ?? []).filter((s) => s.by && s.at).map((s) => s.kind));
  for (const kind of need) {
    if (!have.has(kind)) c.error("preflight.signoff_missing", `Nobody has signed off on ${SIGNOFF_LABEL[kind]} yet.`, { path: "signoffs", fix: `Ask the owner to approve ${SIGNOFF_LABEL[kind]} before the ${stage} stage.` });
  }
  return c.result();
}

function checkTiming(c: IssueCollector, at: unknown, dur: unknown, D: number, path: string, label: string): void {
  if (!num(at) || !num(dur) || at < 0 || dur <= 0) {
    c.error("preflight.timing", `${label} has an invalid time or duration.`, { path, fix: "Use output seconds: at 0 or more, duration above 0." });
    return;
  }
  if (D > 0 && at + dur > D + 0.05) c.error("preflight.timing", `${label} runs past the end of the video (${(at + dur).toFixed(2)}s > ${D.toFixed(2)}s).`, { path, fix: "Shorten it or move it earlier." });
}

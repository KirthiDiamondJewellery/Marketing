import { z } from "zod";
import { TimeMap, toFrame } from "./time-map.ts";

/**
 * The edit map (`edit.json`): media-py `cut-plan` output, reviewed by a person before planning. All times are
 * SOURCE seconds, frame-aligned at `fps`. A reviewer can restore a cut or add one; `applyEditMapChanges` keeps the
 * keep ranges, cuts and stats consistent, and approval freezes it.
 */

const seconds = z.number().finite().nonnegative();

/** `filler`: "um"/"uh", guarded fillers ("like", "you know") and short wordless sounds between pauses. */
export const CUT_KINDS = ["silence", "lead_in", "tail", "retake", "edit_note", "sliver", "manual", "filler"] as const;
export type CutKind = (typeof CUT_KINDS)[number];

export const editMapCutSchema = z.object({
  start: seconds,
  end: seconds,
  kind: z.enum(CUT_KINDS),
  /** Plain-language reason shown to the reviewer. */
  reason: z.string(),
  words: z.array(z.string()).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
export type EditMapCut = z.output<typeof editMapCutSchema>;

export const editMapSchema = z.object({
  version: z.literal(1),
  status: z.enum(["review", "approved"]),
  fps: z.number().int().positive(),
  source: z.object({ path: z.string(), durationS: z.number().positive() }),
  keepRanges: z.array(z.object({ start: seconds, end: seconds })),
  cuts: z.array(editMapCutSchema),
  protected: z.array(z.object({ start: seconds, end: seconds, reason: z.string() })).default([]),
  /** Pauses considered but kept, with the reason. */
  kept: z.array(z.object({ start: seconds, end: seconds, reason: z.string() })).default([]),
  /** Things the reviewer should decide (e.g. a later take that looks broken off). */
  flags: z.array(z.object({ at: seconds, message: z.string() })).default([]),
  silence: z.record(z.string(), z.unknown()).optional(),
  stats: z.object({
    sourceS: z.number(),
    outputS: z.number(),
    removedS: z.number(),
    cutCount: z.number().int(),
    keepCount: z.number().int().optional(),
    estimatedMaxPauseS: z.number().optional(),
    estimatedP90PauseS: z.number().optional(),
    estimatedPausesOverLimit: z.number().int().optional(),
  }),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
});
export type EditMap = z.output<typeof editMapSchema>;

export function parseEditMap(input: unknown): EditMap {
  return editMapSchema.parse(input);
}

export function editMapTimeMap(map: EditMap): TimeMap {
  return TimeMap.fromKeepRanges(map.keepRanges, map.fps, map.source.durationS);
}

export type EditMapChanges = {
  /** Indexes into `cuts` to put back (the reviewer wants that part kept). */
  restore?: number[];
  /** Extra source ranges to remove. */
  add?: { start: number; end: number; reason?: string }[];
};

/** Applies reviewer changes; returns a new map (status unchanged). Frame-aligns added cuts. */
export function applyEditMapChanges(map: EditMap, changes: EditMapChanges): EditMap {
  const restore = new Set(changes.restore ?? []);
  for (const i of restore) if (!map.cuts[i]) throw new RangeError(`There is no cut #${i + 1} to restore.`);
  const fps = map.fps;
  const align = (t: number) => toFrame(t, fps) / fps;
  const cuts: EditMapCut[] = map.cuts.filter((_, i) => !restore.has(i));
  for (const a of changes.add ?? []) {
    const start = Math.max(0, align(a.start));
    const end = Math.min(map.source.durationS, align(a.end));
    if (end <= start) throw new RangeError(`The cut ${a.start}–${a.end}s is empty after frame alignment.`);
    cuts.push({ start, end, kind: "manual", reason: a.reason ?? "Removed by the reviewer." });
  }
  cuts.sort((x, y) => x.start - y.start);
  const tm = TimeMap.fromDrops(cuts, fps, map.source.durationS);
  return {
    ...map,
    cuts,
    keepRanges: tm.keepRanges().map((r) => ({ start: round6(r.start), end: round6(r.end) })),
    stats: {
      ...map.stats,
      outputS: round3(tm.outputDurationS),
      removedS: round3(map.source.durationS - tm.outputDurationS),
      cutCount: cuts.length,
      keepCount: tm.keeps.length,
    },
  };
}

export function approveEditMap(map: EditMap, by: string, at: Date = new Date()): EditMap {
  if (map.keepRanges.length === 0) throw new RangeError("The cut list removes everything; restore something first.");
  return { ...map, status: "approved", approvedBy: by, approvedAt: at.toISOString() };
}

/** A short plain-language summary for review messages ("Cut 14 pauses and 1 retake: 61.3s → 44.5s"). */
export function summarizeEditMap(map: EditMap): string {
  const counts = new Map<string, number>();
  for (const c of map.cuts) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const label: Record<string, [string, string]> = {
    silence: ["pause", "pauses"],
    retake: ["retake", "retakes"],
    filler: ["filler", "fillers"],
    edit_note: ["spoken edit note", "spoken edit notes"],
    lead_in: ["lead-in", "lead-ins"],
    tail: ["dead tail", "dead tails"],
    sliver: ["click", "clicks"],
    manual: ["manual cut", "manual cuts"],
  };
  const parts = [...counts].map(([k, n]) => `${n} ${label[k]?.[n === 1 ? 0 : 1] ?? k}`);
  const head = parts.length ? `Cut ${parts.join(", ")}` : "No cuts needed";
  const flags = map.flags.length ? `; ${map.flags.length} thing${map.flags.length === 1 ? "" : "s"} to check` : "";
  return `${head}: ${map.stats.sourceS.toFixed(1)}s → ${map.stats.outputS.toFixed(1)}s${flags}.`;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

import { createHash } from "node:crypto";
import type { EditPlan, Word } from "@attentionos/media";

/**
 * Revision helpers. A revision re-renders only what changed: the renderer reuses every chunk whose inputs are
 * identical, and an audio-only change must leave the picture's stream hash untouched (QC checks it).
 */

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

export function planDigests(plan: EditPlan): { videoDigest: string; audioDigest: string } {
  const { audio, meta: _meta, ...picture } = plan;
  return { videoDigest: digest(picture), audioDigest: digest(audio) };
}

export type RevisionKind = "audio_only" | "video" | "full" | "none";

export function revisionKind(prev: { videoDigest: string; audioDigest: string } | null | undefined, next: { videoDigest: string; audioDigest: string }): RevisionKind {
  if (!prev) return "full";
  const v = prev.videoDigest !== next.videoDigest;
  const a = prev.audioDigest !== next.audioDigest;
  if (!v && !a) return "none";
  if (!v && a) return "audio_only";
  return a ? "full" : "video";
}

/** "rf-12 v2: tighten the hook" → { ref: "rf-12", version: 2, notes: "tighten the hook" }. */
export function parseRevisionText(text: string): { ref: string; version: number | null; notes: string } | null {
  const m = /^\s*(rf-\d+)(?:\s+v(\d+))?\s*[:\-–—,]?\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const notes = (m[3] ?? "").trim();
  return { ref: m[1]!.toLowerCase(), version: m[2] ? Number(m[2]) : null, notes };
}

/**
 * The spoken hook of a clip: the first sentence, or the words in the first 3.5 s when there is no sentence end,
 * capped at 25 words. Used for research (competitor posts) and for hook banks.
 */
export function spokenHook(words: readonly Pick<Word, "text" | "start" | "end">[]): string {
  const out: string[] = [];
  for (const w of words) {
    if (out.length >= 25) break;
    if (out.length > 0 && w.start > 3.5 && !/[.?!]$/.test(out[out.length - 1]!)) break;
    out.push(w.text.trim());
    if (/[.?!]["')\]]*$/.test(w.text.trim()) && (w.end >= 1.0 || out.length >= 4)) break;
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

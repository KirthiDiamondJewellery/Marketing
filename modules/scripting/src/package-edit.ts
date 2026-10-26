import { sentences } from "@attentionos/guardrails";

/**
 * Fewer words for the model to type. A script package repeats itself (the body is the beats joined; the hook text
 * is the start of the hook beat), and a revision usually fixes one line. So the save tool builds what it can from
 * the beats, and accepts a `patch` against the last package sent for the same content in this run.
 */

type Beat = { role?: unknown; text?: unknown };
type Pkg = Record<string, unknown>;

const beatsOf = (p: Pkg): Beat[] | null => (Array.isArray(p.beats) ? (p.beats as Beat[]) : null);
const hookOf = (beats: Beat[] | null) => beats?.find((b) => b?.role === "hook");

/** Fills `body` from the beats and `hookText` from the hook beat's first sentence when they are left out. */
export function completePackage(raw: Pkg): Pkg {
  const pkg = { ...raw };
  const beats = beatsOf(pkg);
  if (beats && (typeof pkg.body !== "string" || !pkg.body.trim())) pkg.body = beats.map((b) => String(b?.text ?? "")).join(" ");
  const hook = hookOf(beats);
  if (hook && (typeof pkg.hookText !== "string" || !pkg.hookText.trim())) pkg.hookText = sentences(String(hook.text ?? ""))[0] ?? String(hook.text ?? "");
  return pkg;
}

export type PackagePatch = Pkg & {
  /** Replace single beats by position (0-based) instead of resending them all. */
  beatEdits?: { index: number; text: string; role?: string }[];
};

/**
 * Applies a patch to the last package: top-level fields replace, `captions` merge per platform, `beatEdits`
 * replace beats by index. The body and hook text are rebuilt from the beats unless the patch sets them.
 */
export function applyPatch(base: Pkg, patch: PackagePatch): Pkg {
  const { beatEdits, ...fields } = patch;
  const out: Pkg = { ...base, ...fields };
  if (fields.captions && base.captions && typeof fields.captions === "object" && typeof base.captions === "object") {
    out.captions = { ...(base.captions as Pkg), ...(fields.captions as Pkg) };
  }
  let beats = beatsOf(out) ? [...(beatsOf(out) as Beat[])] : null;
  if (beatEdits?.length && beats) {
    for (const e of beatEdits) {
      if (!Number.isInteger(e.index) || e.index < 0 || e.index >= beats.length) continue;
      beats[e.index] = { ...beats[e.index], text: e.text, ...(e.role ? { role: e.role } : {}) };
    }
    out.beats = beats;
  }
  beats = beatsOf(out);
  const beatsChanged = Boolean(beatEdits?.length) || "beats" in fields;
  if (beatsChanged && !("body" in fields)) delete out.body;
  if (beatsChanged && !("hookText" in fields) && JSON.stringify(hookOf(beats)) !== JSON.stringify(hookOf(beatsOf(base)))) delete out.hookText;
  return completePackage(out);
}

/** The last package sent per content id, for patches. The MCP server process lives for one agent run. */
const lastSent = new Map<string, Pkg>();
const MAX_KEPT = 200;

export function rememberPackage(contentId: string, pkg: Pkg): void {
  lastSent.delete(contentId);
  lastSent.set(contentId, pkg);
  if (lastSent.size > MAX_KEPT) lastSent.delete(lastSent.keys().next().value!);
}

export function lastPackage(contentId: string): Pkg | null {
  return lastSent.get(contentId) ?? null;
}

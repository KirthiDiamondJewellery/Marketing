/**
 * How the Film page sorts pieces (pure, so it is unit-tested):
 *
 * - ready:   scripted with the latest script approved (shoot it now), or already marked as filmed
 * - waiting: the latest script passed every check and waits for the owner's OK (approve it right here)
 * - ideas:   filmable ideas with no usable script yet (being written, never written, rejected, a draft that
 *            failed the checks and needs a person, or a passing draft that was never sent for an OK)
 *
 * "Latest" means the newest version that hasn't been superseded. Text and carousel pieces are never filmed.
 */

export type FilmScriptRow = {
  id: string;
  version: number;
  status: string;
  ok: boolean | null;
};

export type FilmRow = {
  id: string;
  status: string;
  kind: string;
  script: FilmScriptRow | null;
  /** The pending script approval for the latest version, if there is one. */
  approval: { id: string; ref: string } | null;
  /** A write-script run for this piece is queued or running. */
  writing: boolean;
};

export type IdeaState = "writing" | "new" | "rejected" | "needs_fix" | "draft";

const NOT_FILMED = new Set(["text", "carousel"]);

export function ideaState(r: Pick<FilmRow, "script" | "writing">): IdeaState {
  if (r.writing) return "writing";
  if (!r.script) return "new";
  if (r.script.status === "rejected") return "rejected";
  // A passing draft nobody was asked to OK (saved without an approval request) vs one that failed the checks.
  return r.script.ok === true ? "draft" : "needs_fix";
}

export function groupFilm<T extends FilmRow>(rows: T[]): { ready: T[]; waiting: T[]; ideas: (T & { state: IdeaState })[] } {
  const ready: T[] = [];
  const waiting: T[] = [];
  const ideas: (T & { state: IdeaState })[] = [];
  for (const r of rows) {
    if (NOT_FILMED.has(r.kind)) continue;
    const s = r.script;
    if ((s?.status === "approved" && r.status === "scripted") || (s && s.status !== "rejected" && r.status === "filming")) {
      // Already filmed pieces stay on the list until their take is in, whatever happened to the script since.
      ready.push(r);
    } else if (s?.status === "draft" && s.ok === true && r.approval && (r.status === "idea" || r.status === "scripted")) {
      waiting.push(r);
    } else if (r.status === "idea" || (r.status === "scripted" && s?.status !== "approved")) {
      // Includes a scripted piece being rewritten from the owner's notes (its approval was decided "changes").
      ideas.push({ ...r, state: ideaState(r) });
    }
  }
  return { ready, waiting, ideas };
}

/** Ideas the "Write scripts for today" button asks for: never-scripted ones first, soonest deadline first (rows arrive sorted). */
export function scriptableIdeas<T extends { id: string; state: IdeaState }>(ideas: T[], limit: number): T[] {
  return ideas.filter((i) => i.state === "new").slice(0, Math.max(0, limit));
}

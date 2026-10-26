"use client";
/** Showcase moments 1–8, triggered on demand in reel mode. Surfaces can claim a moment to play it in place. */
export type MomentId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

type Handler = (m: MomentId) => boolean;
const handlers = new Set<Handler>();
const fallbacks = new Set<(m: MomentId) => void>();

/** Register a surface that can play moments in place (return true when handled). Newest handlers win. */
export function claimMoments(fn: Handler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

/** The overlay host plays anything nobody else claimed. */
export function onUnclaimedMoment(fn: (m: MomentId) => void): () => void {
  fallbacks.add(fn);
  return () => fallbacks.delete(fn);
}

export function triggerMoment(m: MomentId): void {
  for (const h of [...handlers].reverse()) if (h(m)) return;
  for (const f of fallbacks) f(m);
}

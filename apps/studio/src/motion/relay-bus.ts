"use client";
/** Imperative relay trigger (Moment 2). `relay("strategist", "copywriter", "Brief for the spring launch")`. */
export type RelayRequest = { from: string; to: string; summary?: string };

const listeners = new Set<(r: RelayRequest) => void>();

export function relay(from: string, to: string, summary?: string): void {
  const r: RelayRequest = { from, to, ...(summary ? { summary } : {}) };
  for (const fn of listeners) fn(r);
}

export function onRelay(fn: (r: RelayRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** How many relay surfaces are mounted (reel mode shows its own stage when none is). */
export function relayListenerCount(): number {
  return listeners.size;
}

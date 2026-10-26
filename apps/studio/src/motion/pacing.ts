"use client";
import { useSyncExternalStore } from "react";

/**
 * Reel-mode speed multiplier (DESIGN §6.4): 1 = 100%, 0.75, 0.5 = half speed for slow-motion shots.
 * Every showcase moment divides its durations by `pacing.get()`.
 */
type Pace = 1 | 0.75 | 0.5;
const KEY = "aos.reel.pacing";
let value: Pace = 1;
let loaded = false;
const subs = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const v = Number(window.localStorage.getItem(KEY));
    if (v === 1 || v === 0.75 || v === 0.5) value = v;
  } catch {
    // Storage blocked (private window, embedded preview): keep the default pace.
  }
}

export const pacing = {
  get(): number {
    load();
    return value;
  },
  set(v: Pace): void {
    load();
    value = v;
    try {
      window.localStorage.setItem(KEY, String(v));
    } catch {
      // Storage blocked: the pace still applies for this visit, it just isn't remembered.
    }
    for (const fn of subs) fn();
  },
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};

/** Scales a duration (ms or s) by the current pacing. */
export function paced(d: number): number {
  return d / pacing.get();
}

export function usePacing(): number {
  return useSyncExternalStore(pacing.subscribe, pacing.get, () => 1);
}

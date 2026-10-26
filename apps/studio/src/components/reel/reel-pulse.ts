"use client";
import { useEffect, useRef } from "react";
import type { LiveEvent } from "@/lib/live";
import { useLive } from "@/lib/use-live";
import { STORYLINES } from "./storylines";
import { useReel } from "./ReelProvider";

const EVERY_MS = 25_000;
let synthId = 9_000_000_000;

/**
 * Keeps recordings alive. While reel mode is on it injects the scripted storylines as synthetic live events every ~25s,
 * so every surface reacts. Nothing is written to the database.
 */
export function useReelPulse(enabled?: boolean): void {
  const reel = useReel();
  const live = useLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  const active = enabled ?? reel.on;
  const reelRef = useRef(reel.on);
  reelRef.current = reel.on;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let story = Math.floor(Math.random() * STORYLINES.length);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!cancelled) fn();
      }, ms);
      timers.add(t);
    };

    const playSynthetic = () => {
      const s = STORYLINES[story++ % STORYLINES.length]!;
      for (const step of s.steps) {
        later(step.at * (reelRef.current ? 450 : 1000), () => {
          const base = { id: ++synthId, ts: new Date().toISOString(), agent: step.agent, runId: null };
          let e: LiveEvent;
          if (step.kind === "handoff") e = { ...base, kind: "handoff", message: step.message, to: step.to };
          else if (step.kind === "approval") e = { ...base, kind: "approval", message: step.message };
          else if (step.kind === "cost") e = { ...base, kind: "cost", message: step.message };
          else e = { ...base, kind: "progress", message: step.message };
          liveRef.current.inject([e]);
        });
      }
    };

    const tick = () => {
      if (cancelled) return;
      playSynthetic();
      if (reelRef.current) later(EVERY_MS / 3, playSynthetic);
      if (reelRef.current) later((EVERY_MS * 2) / 3, playSynthetic);
      later(EVERY_MS, tick);
    };
    tick();
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [active]);
}

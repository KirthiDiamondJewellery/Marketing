"use client";
import { useEffect, useRef } from "react";
import { pacing } from "./pacing";

/**
 * One rAF loop per caller, on a paced clock: `t` advances at `pacing` speed so reel slow-motion slows ambient motion too.
 * Callbacks write straight to the DOM (transform / opacity / stroke) and never set React state per frame.
 */
export function useFrame(cb: (t: number, dt: number) => void, active = true): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    let t = 0;
    const loop = (now: number) => {
      const dt = Math.min(64, now - last) * pacing.get();
      last = now;
      t += dt;
      ref.current(t, dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** Promise-based wait on the paced clock (for scripted sequences). Rejects nothing; resolves early if aborted. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const id = setTimeout(resolve, ms / pacing.get());
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    });
  });
}

"use client";
import { useSyncExternalStore } from "react";

/**
 * DESIGN §6.5: respect prefers-reduced-motion everywhere, except while reel mode is on (`<html data-reel="on">`).
 * Returns true when showcase moments should resolve straight to their end state.
 */
function subscribe(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", fn);
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reel"] });
  return () => {
    mq.removeEventListener("change", fn);
    mo.disconnect();
  };
}

export function isShowcaseReduced(): boolean {
  if (typeof window === "undefined") return false;
  if (document.documentElement.dataset.reel === "on") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useShowcaseReduced(): boolean {
  return useSyncExternalStore(subscribe, isShowcaseReduced, () => false);
}

export function isReelOn(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.reel === "on";
}

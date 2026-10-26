"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { pacing, usePacing } from "@/motion/pacing";
import { triggerMoment, type MomentId } from "./moment-bus";

/**
 * Reel mode (DESIGN §6.4): a hidden setting that turns Studio into its own demo reel.
 *   Shift+R or ?reel=1  toggle reel mode (persisted)
 *   1–8                 play showcase moment N
 *   [ and ]             pacing 100% / 75% / 50%
 *   V                   9:16 vertical framing
 */
export type Frame = { x: number; y: number; w: number; h: number };

type ReelState = {
  on: boolean;
  setOn(v: boolean): void;
  toggle(): void;
  vertical: boolean;
  setVertical(v: boolean): void;
  /** The 9:16 capture frame in viewport pixels while vertical framing is on. */
  frame: Frame | null;
  pace: number;
  setPace(v: 1 | 0.75 | 0.5): void;
  trigger(m: MomentId): void;
  /** Short-lived feedback line for the overlay host ("Pacing 75%"). */
  hint: { id: number; text: string } | null;
};

const OFF: ReelState = {
  on: false,
  setOn() {},
  toggle() {},
  vertical: false,
  setVertical() {},
  frame: null,
  pace: 1,
  setPace() {},
  trigger: triggerMoment,
  hint: null,
};

const ReelContext = createContext<ReelState | null>(null);
const KEY = "aos.reel";
const VKEY = "aos.reel.vertical";
const PACES = [1, 0.75, 0.5] as const;

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "on";
  } catch {
    return false;
  }
}
function write(key: string, v: boolean) {
  try {
    window.localStorage.setItem(key, v ? "on" : "off");
  } catch {
    // Storage blocked: the choice applies for this visit only.
  }
}

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

function computeFrame(): Frame {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let h = vh;
  let w = (h * 9) / 16;
  if (w > vw) {
    w = vw;
    h = (w * 16) / 9;
  }
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

export function ReelProvider({ children }: { children: ReactNode }) {
  const [on, setOnState] = useState(false);
  const [vertical, setVerticalState] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [hint, setHint] = useState<ReelState["hint"]>(null);
  const pace = usePacing();

  const say = useCallback((text: string) => {
    const id = Date.now();
    setHint({ id, text });
    setTimeout(() => setHint((h) => (h?.id === id ? null : h)), 1100);
  }, []);

  const setOn = useCallback(
    (v: boolean) => {
      setOnState(v);
      write(KEY, v);
      say(v ? "Reel mode on" : "Reel mode off");
    },
    [say],
  );
  const setVertical = useCallback((v: boolean) => {
    setVerticalState(v);
    write(VKEY, v);
  }, []);
  const setPace = useCallback(
    (v: 1 | 0.75 | 0.5) => {
      pacing.set(v);
      say(`Pacing ${Math.round(v * 100)}%`);
    },
    [say],
  );

  // Initial state: persisted value, overridden by ?reel=1 / ?reel=0.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("reel");
    const initial = q === "1" ? true : q === "0" ? false : read(KEY);
    setOnState(initial);
    if (q !== null) write(KEY, initial);
    const v = new URLSearchParams(window.location.search).get("vertical");
    setVerticalState(v === "1" ? true : v === "0" ? false : read(VKEY));
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.reel = "on";
    else delete root.dataset.reel;
  }, [on]);

  useEffect(() => {
    if (!on || !vertical) return setFrame(null);
    const update = () => setFrame(computeFrame());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [on, vertical]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.shiftKey && (e.key === "R" || e.key === "r")) {
        e.preventDefault();
        setOn(!on);
        return;
      }
      if (!on || e.shiftKey) return;
      if (/^[1-8]$/.test(e.key)) {
        e.preventDefault();
        triggerMoment(Number(e.key) as MomentId);
      } else if (e.key === "[" || e.key === "]") {
        const i = PACES.indexOf(pacing.get() as 1 | 0.75 | 0.5);
        const next = PACES[Math.max(0, Math.min(PACES.length - 1, (i < 0 ? 0 : i) + (e.key === "[" ? 1 : -1)))]!;
        setPace(next);
      } else if (e.key === "v" || e.key === "V") {
        setVertical(!vertical);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on, vertical, setOn, setPace, setVertical]);

  const value = useMemo<ReelState>(
    () => ({ on, setOn, toggle: () => setOn(!on), vertical: on && vertical, setVertical, frame, pace, setPace, trigger: triggerMoment, hint }),
    [on, setOn, vertical, setVertical, frame, pace, setPace, hint],
  );

  return (
    <ReelContext.Provider value={value}>
      {on && (
        // Clean capture: no cursor (globals.css), no toasts, notifications or dev overlays.
        <style>{`[data-reel="on"] [data-toast],[data-reel="on"] [data-notification],[data-reel="on"] [data-reel-hide],[data-reel="on"] nextjs-portal{display:none!important}`}</style>
      )}
      {children}
    </ReelContext.Provider>
  );
}

/** Reel mode state. Safe outside the provider (returns "off"). */
export function useReel(): ReelState {
  return useContext(ReelContext) ?? OFF;
}

"use client";
import { useCallback, useEffect, useState } from "react";
import { nextIndex, prevIndex, stopIndex, STOPS, type Stop } from "./camera";
import type { StopId } from "./layout";

export interface Tour {
  stop: Stop;
  index: number;
  hold: boolean;
  /** True when the camera is parked and will not move until the viewer resumes. */
  paused: boolean;
  jump: (id: StopId) => void;
  step: (dir: 1 | -1) => void;
  toggleHold: () => void;
}

interface State {
  index: number;
  hold: boolean;
  pinned: boolean;
}

/** The camera tour as React state: where the camera is, whether it is parked, and the timer that moves it on. */
export function useTour(startHeld: boolean, still: boolean): Tour {
  const [state, setState] = useState<State>({ index: 0, hold: startHeld, pinned: false });

  useEffect(() => {
    if (state.hold || state.pinned || still) return;
    const id = window.setTimeout(() => setState((s) => ({ ...s, index: nextIndex(s.index) })), STOPS[state.index]!.dwell);
    return () => window.clearTimeout(id);
  }, [state, still]);

  const jump = useCallback((id: StopId) => setState({ index: stopIndex(id), hold: false, pinned: true }), []);
  const step = useCallback((dir: 1 | -1) => setState((s) => ({ index: dir === 1 ? nextIndex(s.index) : prevIndex(s.index), hold: false, pinned: true })), []);
  const toggleHold = useCallback(
    () => setState((s) => (s.hold || s.pinned ? { index: s.hold ? 0 : s.index, hold: false, pinned: false } : { index: 0, hold: true, pinned: false })),
    [],
  );

  return { stop: STOPS[state.index]!, index: state.index, hold: state.hold, paused: state.hold || state.pinned, jump, step, toggleHold };
}

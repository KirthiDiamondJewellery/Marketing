"use client";
// Full screen for filming: the browser hides its tabs and address bar and the element fills the display.
// Safari still needs the webkit-prefixed calls, so both spellings are handled.

import { useCallback, useEffect, useState, type RefObject } from "react";

type FsDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export interface Fullscreen {
  supported: boolean;
  active: boolean;
  toggle: () => void;
}

const current = (doc: FsDocument): Element | null => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

export function useFullscreen(target: RefObject<HTMLElement | null>): Fullscreen {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const doc = document as FsDocument;
    setSupported(Boolean(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled));
    const sync = () => setActive(current(doc) !== null && current(doc) === target.current);
    sync();
    doc.addEventListener("fullscreenchange", sync);
    doc.addEventListener("webkitfullscreenchange", sync);
    return () => {
      doc.removeEventListener("fullscreenchange", sync);
      doc.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [target]);

  const toggle = useCallback(() => {
    const doc = document as FsDocument;
    const el = target.current as FsElement | null;
    if (!el) return;
    const leaving = current(doc) !== null;
    const call = leaving ? (doc.exitFullscreen ?? doc.webkitExitFullscreen) : (el.requestFullscreen ?? el.webkitRequestFullscreen);
    if (!call) return;
    try {
      // The browser can refuse (an embedded frame, say). The page still works without it.
      Promise.resolve(call.call(leaving ? doc : el)).catch(() => setActive(current(doc) === el));
    } catch {
      setActive(current(doc) === el);
    }
  }, [target]);

  return { supported, active, toggle };
}

"use client";
import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck } from "lucide-react";
import { usePacing } from "./pacing";
import { useShowcaseReduced } from "./reduced";
import { EASE_IN, EASE_OUT, SIGNAL_BLOOM, STAGGER_MS } from "./tokens";

/**
 * Moment 6, approve all (~1s for ten items): cards exit right in a 60ms stagger, each leaving a brief Signal streak from
 * its left edge; as the last clears the queue count rolls to zero and the empty state fades in.
 * Children render untouched while `play` is false.
 */
export function ApproveAllCascade({ children, play, onDone, emptyState, gap = 12 }: { children: ReactNode[]; play: boolean; onDone?: () => void; emptyState?: ReactNode; gap?: number }) {
  const reduced = useShowcaseReduced();
  const pace = usePacing();
  const items = Children.toArray(children);
  const [frozen, setFrozen] = useState<ReactNode[] | null>(null);
  const [cleared, setCleared] = useState(false);
  const [minH, setMinH] = useState<number | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!play) {
      setFrozen(null);
      setCleared(false);
      setMinH(undefined);
      return;
    }
    setFrozen(items);
    // Hold the list's height so the empty state lands where the queue was, without the page jumping.
    setMinH(box.current?.offsetHeight);
    const n = items.length;
    const total = reduced ? 200 : (Math.max(0, n - 1) * STAGGER_MS + 420) / pace;
    const t1 = setTimeout(() => setCleared(true), total);
    const t2 = setTimeout(() => done.current?.(), total + (reduced ? 0 : 400 / pace));
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // Freeze the list at the moment the cascade starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);

  const list = frozen ?? items;
  const n = list.length;

  return (
    <div ref={box} style={{ position: "relative", minHeight: minH, display: "grid", alignContent: cleared ? "center" : "start" }}>
      <AnimatePresence mode="wait" initial={false}>
        {!cleared ? (
          <motion.div key="list" exit={{ opacity: 0, transition: { duration: 0.12 } }} style={{ display: "grid", gap }}>
            {list.map((child, i) => (
              <div key={i} style={{ position: "relative" }}>
                {play && !reduced && (
                  <motion.span
                    aria-hidden
                    initial={{ scaleX: 0, opacity: 0 }}
                    animate={{ scaleX: [0, 1, 1], opacity: [0, 1, 0] }}
                    transition={{ delay: (i * STAGGER_MS) / 1000 / pace, duration: 0.56 / pace, times: [0, 0.6, 1], ease: EASE_IN }}
                    style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 2, marginTop: -1, background: "var(--brand)", boxShadow: SIGNAL_BLOOM, transformOrigin: "0 50%", zIndex: 0 }}
                  />
                )}
                <motion.div
                  initial={false}
                  animate={play ? { x: reduced ? 0 : "110%", opacity: 0 } : { x: 0, opacity: 1 }}
                  transition={play ? (reduced ? { duration: 0.2 } : { delay: (i * STAGGER_MS) / 1000 / pace, duration: 0.42 / pace, ease: EASE_IN }) : { duration: 0 }}
                  style={{ position: "relative", zIndex: 1 }}
                >
                  {child}
                </motion.div>
              </div>
            ))}
          </motion.div>
        ) : (
          <motion.div key="empty" initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32 / pace, ease: EASE_OUT }} style={{ display: "grid", justifyItems: "center", gap: 8, padding: "48px 16px", textAlign: "center" }}>
            {emptyState ?? (
              <>
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, lineHeight: "20px", color: "var(--text-secondary)" }}>
                  <CountDown from={n} durMs={reduced ? 0 : 360 / pace} /> waiting
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20, lineHeight: "28px", fontWeight: 500, color: "var(--text-primary)" }}>
                  <CircleCheck size={20} strokeWidth={1.5} color="var(--success)" />
                  Queue clear. Your agents are on it.
                </span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CountDown({ from, durMs }: { from: number; durMs: number }) {
  const [v, setV] = useState(durMs ? from : 0);
  useEffect(() => {
    if (!durMs) return setV(0);
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const p = Math.min(1, (now - start) / durMs);
      setV(Math.round(from * (1 - p)));
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [from, durMs]);
  return <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 500 }}>{v}</span>;
}

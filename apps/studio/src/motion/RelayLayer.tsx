"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useLive } from "@/lib/use-live";
import { CometField } from "./comet";
import { useFrame } from "./frame";
import { paced } from "./pacing";
import { useShowcaseReduced } from "./reduced";
import { onRelay, type RelayRequest } from "./relay-bus";
import { EASE_OUT, SIGNAL_BLOOM_FILTER } from "./tokens";

type Summary = { id: number; to: string; text: string };

/**
 * Moment 2, the relay. Mount inside a positioned container; `anchors` are agent-key → point in that container's pixels.
 * Flies a comet for every live `handoff` event and every `relay()` call, ignites the receiver and slides a one-line
 * summary in beneath it. Parallel handoffs leave 120ms apart so a busy team reads as a live network.
 */
export function RelayLayer({ anchors }: { anchors: Record<string, { x: number; y: number }> }) {
  const live = useLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  const reduced = useShowcaseReduced();
  const group = useRef<SVGGElement>(null);
  const field = useRef<CometField | null>(null);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const names = useRef<Record<string, string>>({});
  names.current = Object.fromEntries((live.snapshot?.agents ?? []).map((a) => [a.key, a.name]));
  const lastLaunch = useRef(0);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const seq = useRef(0);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  useEffect(() => {
    if (!group.current) return;
    field.current = new CometField(group.current, (id) => anchorsRef.current[id] ?? null, { bend: 0.28 });
    return () => field.current?.clear();
  }, []);

  useFrame((t) => field.current?.tick(t));

  useEffect(() => {
    const fire = (r: RelayRequest) => {
      if (!anchorsRef.current[r.from] || !anchorsRef.current[r.to]) return;
      const text = r.summary ?? `${names.current[r.from] ?? r.from} → ${names.current[r.to] ?? r.to}`;
      const show = () => {
        const id = ++seq.current;
        setSummaries((s) => [...s.filter((x) => x.to !== r.to), { id, to: r.to, text }]);
        setTimeout(() => setSummaries((s) => s.filter((x) => x.id !== id)), paced(2800));
      };
      if (reducedRef.current) return show();
      const now = performance.now();
      const delay = Math.max(0, lastLaunch.current + 120 - now);
      lastLaunch.current = now + delay;
      field.current?.launch({ from: r.from, to: r.to, delayMs: delay, durationMs: 900, onArrive: show });
    };
    const offBus = onRelay(fire);
    const offLive = liveRef.current.onEvent((e) => {
      if (e.kind === "handoff" && e.to) fire({ from: e.agent, to: e.to, summary: e.message });
    });
    return () => {
      offBus();
      offLive();
    };
  }, []);

  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible", zIndex: 5 }}>
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", filter: SIGNAL_BLOOM_FILTER }}>
        <g ref={group} />
      </svg>
      <AnimatePresence>
        {summaries.map((s) => {
          const a = anchors[s.to];
          if (!a) return null;
          return (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: reduced ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              style={{
                position: "absolute",
                left: a.x,
                top: a.y + 26,
                translateX: "-50%",
                whiteSpace: "nowrap",
                fontSize: 12,
                lineHeight: "16px",
                padding: "4px 8px",
                borderRadius: 6,
                background: "var(--surface-3)",
                color: "var(--text-primary)",
                maxWidth: 280,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {s.text}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

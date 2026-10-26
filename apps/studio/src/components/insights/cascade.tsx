"use client";
import { Children, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

/** Supporting metrics cascade in below the briefing figure with a 60ms stagger (Moment 8). */
export function Cascade({ children, className, delay = 0.5 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduced = useReducedMotion();
  return (
    <div className={className}>
      {Children.toArray(children).map((child, i) => (
        <motion.div
          key={i}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduced ? 0.2 : 0.4, ease: [0.2, 0.8, 0.2, 1], delay: reduced ? 0 : delay + i * 0.06 }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  );
}

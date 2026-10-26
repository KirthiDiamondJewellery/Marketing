"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { AgentLive } from "@/lib/live";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { EASE_OUT } from "@/motion/tokens";
import { plainLabel } from "./geometry";

const W = 296;
const H_EST = 210;

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function elapsed(fromIso: string | null | undefined, now: number): string | null {
  if (!fromIso) return null;
  const s = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const STATE_TEXT: Record<AgentLive["state"], string> = {
  working: "Working",
  waiting: "Waiting on you",
  idle: "Idle",
  paused: "Paused",
  blocked: "Blocked",
};

/** The command view's hover card: what this agent is doing right now, in plain language. */
export function AgentCard({
  agent,
  latest,
  x,
  y,
  side,
  gap,
  frameW,
  frameH,
  onEnter,
  onLeave,
}: {
  agent: AgentLive;
  latest?: string;
  x: number;
  y: number;
  side: "left" | "right";
  gap: number;
  frameW: number;
  frameH: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const now = useNow();
  const run = elapsed(agent.run?.startedAt, now);
  const task = plainLabel(agent.state === "working" ? (latest ?? agent.label) : agent.label);
  let left = side === "right" ? x + gap : x - gap - W;
  if (left < 12 || left + W > frameW - 12) left = Math.min(frameW - W - 12, Math.max(12, x - W / 2));
  const top = Math.min(frameH - H_EST - 12, Math.max(12, y - H_EST / 2));

  return (
    <motion.div
      role="dialog"
      aria-label={`${agent.name}: ${task}`}
      initial={{ opacity: 0, x: side === "right" ? -8 : 8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{ position: "absolute", left, top, width: W, zIndex: 20, borderRadius: 16, background: "var(--surface-3)", boxShadow: "var(--shadow-3)", padding: 16, display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AgentMonogram agent={agent} size={32} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, lineHeight: "24px", fontWeight: 500, color: "var(--text-primary)" }}>{agent.name}</div>
          <div style={{ fontSize: 13, lineHeight: "20px", color: "var(--text-secondary)" }}>{agent.role}</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ fontSize: 12, lineHeight: "16px", fontWeight: 500, color: agent.state === "blocked" ? "var(--danger)" : agent.state === "idle" || agent.state === "paused" ? "var(--text-muted)" : "var(--text-on-tint)" }}>
          {STATE_TEXT[agent.state]}
        </div>
        <div style={{ fontSize: 15, lineHeight: "22px", color: "var(--text-primary)" }}>{task}</div>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 4, columnGap: 12, margin: 0, fontSize: 13, lineHeight: "20px" }}>
        {run && (
          <>
            <dt style={{ color: "var(--text-secondary)" }}>Running for</dt>
            <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{run}</dd>
          </>
        )}
        <dt style={{ color: "var(--text-secondary)" }}>Waiting on you</dt>
        <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums", color: agent.pendingApprovals ? "var(--text-on-tint)" : "var(--text-primary)" }}>{agent.pendingApprovals}</dd>
        <dt style={{ color: "var(--text-secondary)" }}>Runs today</dt>
        <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{agent.runs24h}</dd>
        <dt style={{ color: "var(--text-secondary)" }}>Spent today</dt>
        <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>${agent.costTodayUsd.toFixed(2)}</dd>
      </dl>
      <Link href={`/agents/${agent.key}`} style={{ fontSize: 13, lineHeight: "20px", color: "var(--brand-fg)", textDecoration: "none", fontWeight: 500 }}>
        Open {agent.name}
      </Link>
    </motion.div>
  );
}

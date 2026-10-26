"use client";
import type { CSSProperties } from "react";
import type { AgentLive, AgentState } from "@/lib/live";
import "./motion.css";

const STATE_LABEL: Record<AgentState, string> = {
  working: "working",
  waiting: "waiting on you",
  idle: "idle",
  paused: "paused",
  blocked: "blocked",
};

const FONT: Record<number, number> = { 24: 10, 32: 12, 56: 19, 64: 21 };

/**
 * Agent monogram (DESIGN §7.1/§7.2): a circle on `--surface-3` with the two-letter monogram. The ring carries the state:
 * working = pulsing Signal, waiting = solid Signal + count badge, paused = dashed, blocked = danger, idle = none.
 * The root carries `data-agent-monogram` so Wake the team can find it on screen.
 */
export function AgentMonogram({
  agent,
  size = 32,
  badge,
  className,
  style,
}: {
  agent: Pick<AgentLive, "monogram" | "state" | "name">;
  size?: 24 | 32 | 56 | 64;
  badge?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { state } = agent;
  const ring = size >= 56 ? 2.5 : 2;
  const outer = size + (ring + 2) * 2;
  const r = size / 2 + 2 + ring / 2;
  const c = outer / 2;
  const stroke =
    state === "working" || state === "waiting" ? "var(--brand)" : state === "blocked" ? "var(--danger)" : state === "paused" ? "var(--border-strong)" : "transparent";
  const count = badge ?? 0;
  const dot = size >= 56 ? 3.2 : 2.4;

  return (
    <span
      data-agent-monogram={agent.monogram}
      role="img"
      aria-label={`${agent.name}, ${STATE_LABEL[state]}`}
      title={agent.name}
      className={className}
      style={{ position: "relative", display: "inline-grid", placeItems: "center", width: outer, height: outer, flex: "none", ...style }}
    >
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 999,
          background: "var(--surface-3)",
          color: "var(--text-primary)",
          display: "grid",
          placeItems: "center",
          fontFamily: "var(--font-sans)",
          fontWeight: 500,
          fontSize: FONT[size] ?? 12,
          lineHeight: 1,
          letterSpacing: "0.01em",
          userSelect: "none",
        }}
      >
        {agent.monogram}
      </span>
      {state !== "idle" && (
        <svg width={outer} height={outer} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible" }} className={state === "working" ? "signal-pulse" : undefined}>
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth={ring}
            strokeDasharray={state === "paused" ? `${Math.max(2, size / 10)} ${Math.max(2.5, size / 9)}` : undefined}
            strokeLinecap={state === "paused" ? "round" : undefined}
          />
        </svg>
      )}
      {state === "working" && (
        // The "agent is thinking" tell: a Signal point orbiting slowly on the ring.
        <span aria-hidden className="aos-thinking" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <span
            style={{
              position: "absolute",
              left: c - dot,
              top: c - r - dot,
              width: dot * 2,
              height: dot * 2,
              borderRadius: 999,
              background: "var(--text-on-tint)",
              boxShadow: "0 0 0 1px var(--brand), 0 0 10px rgba(149, 74, 251, 0.8), 0 0 22px rgba(149, 74, 251, 0.45)",
            }}
          />
        </span>
      )}
      {count > 0 && state === "waiting" && (
        <span
          aria-hidden
          className="aos-ping"
          style={{ position: "absolute", top: size >= 56 ? 0 : -3, right: size >= 56 ? 0 : -5, width: size >= 56 ? 20 : 16, height: size >= 56 ? 20 : 16, borderRadius: 999, boxShadow: "0 0 0 1.5px var(--brand)", pointerEvents: "none" }}
        />
      )}
      {count > 0 && (
        <span
          aria-label={`${count} waiting`}
          style={{
            position: "absolute",
            top: size >= 56 ? 0 : -3,
            right: size >= 56 ? 0 : -5,
            minWidth: size >= 56 ? 20 : 16,
            height: size >= 56 ? 20 : 16,
            padding: "0 4px",
            borderRadius: 999,
            background: "var(--brand)",
            color: "var(--on-brand)",
            fontSize: size >= 56 ? 11 : 10,
            fontWeight: 500,
            lineHeight: size >= 56 ? "20px" : "16px",
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
            boxShadow: "0 0 0 2px var(--bg)",
          }}
        >
          {count}
        </span>
      )}
    </span>
  );
}

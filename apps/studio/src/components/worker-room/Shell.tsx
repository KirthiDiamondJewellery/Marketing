// The floor: slab, light pools, the lines that plug every team into the Brand Brain, and one raised pad per team
// with its name painted on it. A team's floor line lights up and flows only while its agent is working.

import { memo } from "react";
import type { AgentState } from "@/lib/live";
import { TEAMS, type TeamId } from "./cast";
import { box, floorPlane, iso, poly, S, shade } from "./iso";
import { CHIEF, CHIEF_LINK, CORE, D, ROWS, SLAB, W } from "./layout";
import { P } from "./palette";

const PAD_H = 0.14;

type LinkId = TeamId | "chief";

const tintOf = (id: LinkId): string => (id === "chief" ? P.pink : (TEAMS.find((t) => t.id === id)?.tint ?? P.pink));

function Link({ id, state }: { id: LinkId; state: AgentState }) {
  const pts = id === "chief" ? CHIEF_LINK : ROWS[id].link;
  const d = `M${pts.map(([x, y]) => `${x * S},${y * S}`).join("L")}`;
  const [ex, ey] = pts[pts.length - 1]!;
  const tint = state === "waiting" ? P.amber : state === "blocked" ? P.red : tintOf(id);
  const on = state === "working";
  return (
    <g className={`wr-link wr-link-${state}`}>
      <path d={d} stroke="#2a1840" strokeWidth={7} />
      <path d={d} stroke={tint} strokeWidth={on ? 2.4 : 1.6} className="wr-link-line" />
      {on ? <path d={d} stroke="#fff" strokeWidth={2.2} className="wr-flow" /> : null}
      <rect x={ex * S - 5} y={ey * S - 5} width={10} height={10} rx={2} fill={tint} className="wr-link-end" />
    </g>
  );
}

function Pad({ team, state }: { team: TeamId; state: AgentState }) {
  const row = ROWS[team];
  const base = tintOf(team);
  const tint = state === "waiting" ? P.amber : state === "blocked" ? P.red : base;
  const top = row.pad.map(([x, y]) => iso(x, y, PAD_H));
  const sides = row.pad.map(([x, y], i) => {
    const [nx, ny] = row.pad[(i + 1) % row.pad.length]!;
    const lit = ny - y < 0 || nx - x > 0;
    return { d: poly([iso(x, y, 0), iso(nx, ny, 0), iso(nx, ny, PAD_H), iso(x, y, PAD_H)]), lit };
  });
  const name = TEAMS.find((t) => t.id === team)?.name ?? "";
  const { x, y, along } = row.label;
  return (
    <g className={`wr-pad wr-pad-${state}`}>
      {sides.map((s, i) => (
        <path key={i} d={s.d} fill={shade(base, s.lit ? 0.35 : 0.6)} />
      ))}
      <path d={poly(top)} fill={P.pad} />
      <path d={poly(top)} fill="none" stroke={tint} strokeWidth={6} strokeLinejoin="round" className="wr-pad-glow" />
      <path d={poly(top)} fill="none" stroke={tint} strokeWidth={1.2} strokeLinejoin="round" className="wr-pad-edge" />
      <g transform={floorPlane(PAD_H)}>
        <text
          transform={`translate(${x * S} ${y * S})${along === "y" ? " rotate(-90)" : along === "front" ? " rotate(-45)" : ""}`}
          fontFamily="var(--font-mono)"
          fontSize={along === "front" ? 14 : 11.5}
          fontWeight={600}
          letterSpacing={3.2}
          fill={tint}
          className="wr-pad-name"
        >
          {name.toUpperCase()}
        </text>
      </g>
    </g>
  );
}

/** Slab, floor, light pools, floor lines and team pads. Re-renders only when an agent changes state. */
export const Shell = memo(function Shell({ states, chief }: { states: Record<TeamId, AgentState>; chief: AgentState }) {
  const slab = box(0, 0, -SLAB, W, D, SLAB);
  const floor = poly([iso(0, 0), iso(W, 0), iso(W, D), iso(0, D)]);
  const [cx] = iso(CORE.x, CORE.y);
  return (
    <g>
      <ellipse cx={cx} cy={iso(W, D)[1] - 40} rx={W * S * 1.02} ry={W * S * 0.5} fill="url(#wr-glow-violet)" opacity={0.55} />
      <path d={slab.left} fill={P.slab} />
      <path d={slab.right} fill="#060409" />
      <path d={poly([iso(0, D, 0), iso(W, D, 0), iso(W, D, -0.1), iso(0, D, -0.1)])} fill={P.magenta} opacity={0.85} />
      <path d={poly([iso(W, 0, 0), iso(W, D, 0), iso(W, D, -0.1), iso(W, 0, -0.1)])} fill={P.violet} opacity={0.85} />
      <path d={floor} fill={P.floor} />
      <g transform={floorPlane(0)}>
        <circle cx={CORE.x * S} cy={CORE.y * S} r={14 * S} fill="url(#wr-glow-room)" />
        <circle cx={CHIEF.x * S} cy={CHIEF.y * S} r={6.5 * S} fill="url(#wr-glow-room)" />
        <rect x={0.5 * S} y={0.5 * S} width={(W - 1) * S} height={(D - 1) * S} fill="none" stroke={P.floorEdge} strokeWidth={1.4} />
        <circle cx={CORE.x * S} cy={CORE.y * S} r={3.6 * S} fill="none" stroke={P.magenta} strokeWidth={1.1} opacity={0.55} />
        <circle cx={CORE.x * S} cy={CORE.y * S} r={4.3 * S} fill="none" stroke={P.violet} strokeWidth={0.8} opacity={0.4} strokeDasharray="3 9" className="wr-core-orbit" />
      </g>
      <g transform={floorPlane(0)} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <Link id="chief" state={chief} />
        {TEAMS.map((t) => (
          <Link key={t.id} id={t.id} state={states[t.id]} />
        ))}
      </g>
      {TEAMS.map((t) => (
        <Pad key={t.id} team={t.id} state={states[t.id]} />
      ))}
    </g>
  );
}, (a, b) => a.chief === b.chief && TEAMS.every((t) => a.states[t.id] === b.states[t.id]));

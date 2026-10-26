// Floating status tags over each pad: the agent's name and what it is doing right now, straight from the live feed.

import { memo } from "react";
import { TEAMS, type TeamId } from "./cast";
import { tagPoint } from "./layout";
import { P } from "./palette";
import type { TeamLive } from "./types";

const MAX = 36;

function statusText(t: TeamLive): string {
  if (t.state === "working") return t.label || "Working";
  if (t.state === "waiting") return t.label || (t.pending ? `${t.pending} ${t.pending === 1 ? "thing needs" : "things need"} you` : "Needs you");
  if (t.state === "blocked") return t.label || "Stuck, needs a look";
  if (t.state === "paused") return "Paused";
  return "";
}

function clip(s: string): string {
  return s.length > MAX ? `${s.slice(0, MAX - 1).trimEnd()}…` : s;
}

export function Tag({ x, y, name, text, state, tint }: { x: number; y: number; name: string; text: string; state: string; tint: string }) {
  const color = state === "waiting" ? P.amber : state === "blocked" ? P.red : tint;
  const nameW = name.length * 5.3;
  const textW = text ? text.length * 4.75 + 10 : 0;
  const w = 22 + nameW + textW;
  return (
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} className={`wr-tag wr-tag-${state}`}>
      <rect x={-w / 2} y={-10} width={w} height={20} rx={10} fill="#0b0712" fillOpacity={0.92} stroke={color} strokeWidth={state === "idle" ? 0.8 : 1.3} />
      <circle cx={-w / 2 + 10} cy={0} r={3} fill={color} className="wr-tag-dot" />
      <text x={-w / 2 + 17} y={3.3} fontSize={9.4} fontWeight={650} fill={P.ink}>
        {name}
        {text ? (
          <tspan dx={6} fontWeight={450} fill={state === "working" ? "#fff" : color === tint ? P.lilac : color}>
            {text}
          </tspan>
        ) : null}
      </text>
    </g>
  );
}

export const TeamTags = memo(function TeamTags({ teams }: { teams: Record<TeamId, TeamLive> }) {
  return (
    <g pointerEvents="none">
      {TEAMS.map((team) => {
        const t = teams[team.id];
        const [x, y] = tagPoint(team.id);
        return <Tag key={team.id} x={x} y={y} name={t.name} text={clip(statusText(t))} state={t.state} tint={team.tint} />;
      })}
    </g>
  );
});

export { statusText };

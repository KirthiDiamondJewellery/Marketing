// The Brand Brain: the knowledge base every agent reads from. A plinth in the middle of the room projecting a
// holographic brain, with rings that turn and cards that rise into it. It burns brighter while anyone is working.

import { memo } from "react";
import { CORE_NAME } from "./cast";
import { Box } from "./Box";
import { iso } from "./iso";
import { CORE } from "./layout";
import { P } from "./palette";

const RINGS = [
  { z: 1.25, rx: 30, o: 0.55 },
  { z: 1.95, rx: 25, o: 0.7 },
  { z: 2.65, rx: 21, o: 0.85 },
  { z: 3.35, rx: 17, o: 1 },
] as const;

const OUTLINE =
  "M-18,4 C-22,-2 -19,-10 -12,-11 C-11,-16 -3,-18 1,-14 C5,-19 13,-17 14,-11 " +
  "C20,-10 22,-3 18,2 C20,7 15,11 10,9 C7,13 1,12 -1,8 C-6,11 -12,10 -13,6 C-16,7 -18,6 -18,4 Z";
const FOLDS = [
  "M-12,-4 C-8,-8 -4,-2 0,-6 C4,-10 8,-4 12,-7",
  "M-11,3 C-7,-1 -3,5 2,1 C6,-2 10,3 15,0",
  "M1,-14 C-1,-10 3,-8 1,-4",
  "M-1,8 C1,4 -2,2 0,-1",
  "M8,9 C10,14 16,13 17,8",
  "M-16,-2 C-13,-5 -10,-1 -7,-3",
  "M6,-13 C8,-10 6,-8 9,-5",
  "M-6,-13 C-7,-10 -4,-9 -6,-6",
  "M14,-4 C16,-1 13,1 16,4",
  "M-9,7 C-7,4 -5,7 -3,4",
] as const;
const STEM = "M3,10 C4,14 6,16 7,19";
const SCAN_LINES = [-14, -9, -4, 1, 6, 11] as const;

function HoloBrain({ cx, cy, baseX, baseY, scale = 3.5 }: { cx: number; cy: number; baseX: number; baseY: number; scale?: number }) {
  const half = 22 * scale;
  return (
    <g className="wr-holo">
      <defs>
        <clipPath id="wr-holo-clip">
          <path d={OUTLINE} />
        </clipPath>
      </defs>
      <path d={`M${cx - half},${cy + 10} L${cx + half},${cy + 10} L${baseX + 5},${baseY} L${baseX - 5},${baseY} Z`} fill="url(#wr-holo-cone)" />
      <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
        <g className="wr-holo-brain">
          <circle cx={0} cy={-2} r={34} fill="url(#wr-glow-floor)" opacity={0.9} />
          <path d={OUTLINE} fill="#16081f" opacity={0.82} />
          <path d={OUTLINE} fill="url(#wr-holo-fill)" stroke="#fff" strokeWidth={1.1} strokeLinejoin="round" />
          <path d={OUTLINE} fill="none" stroke={P.pink} strokeWidth={2.6} strokeLinejoin="round" opacity={0.45} />
          <g fill="none" stroke="#fff" strokeWidth={0.8} strokeLinecap="round" opacity={0.95}>
            {FOLDS.map((d) => (
              <path key={d} d={d} />
            ))}
            <path d={STEM} stroke={P.pink} strokeWidth={1.4} />
          </g>
          <g clipPath="url(#wr-holo-clip)">
            {SCAN_LINES.map((y) => (
              <rect key={y} x={-24} y={y} width={48} height={0.5} fill="#fff" opacity={0.16} />
            ))}
            <rect className="wr-holo-scan" x={-24} y={-1.2} width={48} height={2.4} fill="#fff" opacity={0.7} />
          </g>
        </g>
      </g>
    </g>
  );
}

export const Core = memo(function Core({ busy, off }: { busy: boolean; off: boolean }) {
  const { x, y } = CORE;
  const [bx, by] = iso(x, y, 0.6);
  const [ox, oy] = iso(x, y, 4.6);
  const [tx, ty] = iso(x + 1.5, y + 1.5, 0);
  const tagW = CORE_NAME.length * 4.6 + 20;
  return (
    <g className={`wr-core${busy ? " is-busy" : ""}${off ? " is-off" : ""}`}>
      <Box b={[x - 1.5, y - 1.5, 0, 3, 3, 0.3]} color="#1c1230" edge={P.magenta} />
      <Box b={[x - 1.05, y - 1.05, 0.3, 2.1, 2.1, 0.3]} color="#2a1a48" edge={P.pink} />
      <rect x={bx - 15} y={oy - 26} width={30} height={by - oy + 26} fill="url(#wr-beam)" className="wr-core-beam" />
      <circle cx={ox} cy={oy} r={78} fill="url(#wr-glow-floor)" className="wr-core-halo" />
      {RINGS.map((r, i) => {
        const [rx0, ry0] = iso(x, y, r.z);
        return (
          <g key={r.z} className="wr-core-ring" style={{ animationDelay: `${-i * 0.45}s` }}>
            <ellipse cx={rx0} cy={ry0} rx={r.rx} ry={r.rx / 2} fill="none" stroke="url(#wr-core-ring)" strokeWidth={3.2} opacity={r.o} />
            <ellipse cx={rx0} cy={ry0} rx={r.rx} ry={r.rx / 2} fill="none" stroke="#fff" strokeWidth={1} strokeDasharray="5 34" className="wr-core-spin" style={{ animationDelay: `${-i * 0.6}s` }} />
          </g>
        );
      })}
      {[0, 1, 2].map((i) => (
        <g key={i} className="wr-core-card" style={{ animationDelay: `${-i * 1.1}s` }}>
          <rect x={bx - 5 + (i - 1) * 9} y={by - 14} width={9} height={12} rx={1.6} fill="#f4eeff" opacity={0.92} />
          <rect x={bx - 3.4 + (i - 1) * 9} y={by - 11} width={5.6} height={1.3} fill={P.magenta} />
          <rect x={bx - 3.4 + (i - 1) * 9} y={by - 8} width={4} height={1.3} fill="#8a78b4" />
        </g>
      ))}
      <HoloBrain cx={ox} cy={oy - 6} baseX={bx} baseY={by} />
      <g transform={`translate(${tx} ${ty + 14})`}>
        <rect x={-tagW / 2} y={-8} width={tagW} height={16} rx={8} fill="#0b0712" stroke={P.pink} strokeWidth={1} />
        <circle cx={-tagW / 2 + 9} cy={0} r={2.6} fill={P.pink} />
        <text x={5} y={3.1} textAnchor="middle" fontSize={8.6} fontWeight={650} fill={P.ink}>
          {CORE_NAME}
        </text>
      </g>
    </g>
  );
});

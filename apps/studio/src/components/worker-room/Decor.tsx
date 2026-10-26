// Room dressing: two server racks wired to the brain, LEDs blinking.

import { memo } from "react";
import { Box } from "./Box";
import { planeX, S } from "./iso";
import { P } from "./palette";

const RACK = { x: 1.3, w: 1.3, d: 1.7, h: 3.7 };
const RACK_Y = [28.4, 30.4] as const;

function Rack({ y, seed }: { y: number; seed: number }) {
  const rows = [0, 1, 2, 3, 4, 5];
  return (
    <g>
      <Box b={[RACK.x, y, 0, RACK.w, RACK.d, RACK.h]} color="#1d1430" edge="#3a2860" />
      <g transform={planeX(RACK.x + RACK.w, y + RACK.d, RACK.h)}>
        {rows.map((r) => (
          <g key={r}>
            <rect x={4} y={8 + r * 15} width={RACK.d * S - 8} height={10} rx={1.5} fill="#0b0712" stroke="#2f2150" strokeWidth={0.6} />
            {[0, 1, 2, 3].map((c) => (
              <rect key={c} x={7 + c * 6} y={11.4 + r * 15} width={3.4} height={3.2} rx={0.8} fill={(r + c + seed) % 3 === 0 ? P.pink : P.violet} className="wr-rack-led" style={{ animationDelay: `${-((r * 0.7 + c * 0.4 + seed) % 2.4)}s` }} />
            ))}
          </g>
        ))}
      </g>
    </g>
  );
}

export const Racks = memo(function Racks() {
  return (
    <g>
      {RACK_Y.map((y, i) => (
        <Rack key={y} y={y} seed={i} />
      ))}
    </g>
  );
});

export const RACKS_DEPTH = RACK.x + RACK_Y[1];

// The feed: phone screens on the back walls with real posts and their real view counts. The left wall shows the
// workspace's own best posts; a post the Publisher puts out lands on a left wall phone, which flashes and swipes to
// the next post. The right wall shows the tracked competitors' scraped posts, outliers first, under their own handles.
// With no competitors scraped yet, both walls share the workspace's posts. With no posts at all, the phones stay blank.

import { memo } from "react";
import { compact, planeX, planeY, S, Z } from "./iso";
import { D, H, PHONE, phoneStart, WALL_PHONES } from "./layout";
import { P } from "./palette";
import type { FeedCard } from "./types";

const PW = PHONE.w * S;
const PH = (PHONE.z1 - PHONE.z0) * Z;
const IN = 3;
const VW = PW - IN * 2;
const VH = PH - IN * 2;

function Glyphs() {
  return (
    <g fill="none" stroke="#fff" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
      <path d={`M${VW - 8},${VH - 49} c-5,-3.6 -2.6,-7.4 0,-4.6 c2.6,-2.8 5,1 0,4.6 Z`} fill="#fff" stroke="none" />
      <path d={`M${VW - 11.6},${VH - 40} h7.2 a1.6,1.6 0 0 1 1.6,1.6 v3.4 a1.6,1.6 0 0 1 -1.6,1.6 h-3.4 l-2.4,2 v-2 h-1.4 a1.6,1.6 0 0 1 -1.6,-1.6 v-3.4 a1.6,1.6 0 0 1 1.6,-1.6 Z`} />
      <path d={`M${VW - 11.4},${VH - 22.4} l7,-3.2 l-2.6,7 l-1.2,-2.8 Z`} />
    </g>
  );
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const Phone = memo(function Phone({ card, flash, delay, scan, handle }: { card: FeedCard | null; flash: number; delay: number; scan: boolean; handle: string | null }) {
  const who = card?.handle ?? handle;
  const caption = card ? (who ? `@${short(who, 18)}` : short(card.title, 20)) : "";
  return (
    <g>
      <rect x={0} y={0} width={PW} height={PH} rx={8.5} fill="#05030a" stroke="#5a4490" strokeWidth={1.3} />
      <svg x={IN} y={IN} width={VW} height={VH} viewBox={`0 0 ${VW} ${VH}`}>
        <rect width={VW} height={VH} fill="url(#wr-phone-blank)" />
        {card ? (
          <g key={card.id} className="wr-feed-swipe">
            {card.cover ? <image href={card.cover} x={0} y={0} width={VW} height={VH} preserveAspectRatio="xMidYMid slice" /> : null}
          </g>
        ) : (
          <g opacity={0.5}>
            <circle cx={VW / 2} cy={VH / 2 - 6} r={7} fill="none" stroke={P.lilac} strokeWidth={1} />
            <path d={`M${VW / 2 - 2},${VH / 2 - 9.5} l5,3.5 l-5,3.5 Z`} fill={P.lilac} />
          </g>
        )}
        <rect width={VW} height={VH} fill="url(#wr-phone-shade)" />
        <rect x={4} y={4} width={VW - 8} height={1.6} rx={0.8} fill="#fff" opacity={0.35} />
        {card ? <rect x={4} y={4} width={VW - 8} height={1.6} rx={0.8} fill="#fff" className="wr-feed-progress" style={{ animationDelay: `${-delay}s` }} /> : null}
        {card ? <Glyphs /> : null}
        {caption ? (
          <text x={4.5} y={VH - 16.5} fontSize={5.9} fontWeight={600} fill="#fff">
            {caption}
          </text>
        ) : null}
        {card && card.views !== null ? (
          <>
            <path d={`M5,${VH - 11.6} l5.4,3.3 l-5.4,3.3 Z`} fill="#fff" />
            <text x={13} y={VH - 4.6} fontSize={9.4} fontWeight={700} fill="#fff" className="wr-num">
              {compact(card.views)}
            </text>
          </>
        ) : null}
        {scan && card ? <rect x={0} y={-4} width={VW} height={4} fill={P.pink} opacity={0.8} className="wr-feed-scan" style={{ animationDelay: `${delay}s` }} /> : null}
      </svg>
      <rect x={1.6} y={1.6} width={PW - 3.2} height={PH - 3.2} rx={7.4} fill="none" stroke="#05030a" strokeWidth={3.2} />
      {flash ? (
        <g key={flash} className="wr-feed-flash">
          <rect x={-2.5} y={-2.5} width={PW + 5} height={PH + 5} rx={10.5} fill="none" stroke={P.pink} strokeWidth={3} />
          <rect x={IN} y={IN} width={VW} height={VH} rx={6} fill="#fff" className="wr-feed-white" />
        </g>
      ) : null}
    </g>
  );
});

/** Which post a wall phone shows. Each post that lands on a phone moves it on to the next one. */
function cardFor(cards: readonly FeedCard[], side: "L" | "R", k: number, shift: number): FeedCard | null {
  if (!cards.length) return null;
  // Left phones start on the even posts and right phones on the odd ones; a landing post swaps the pair.
  const odd = side === "R" ? shift % 2 === 0 : shift % 2 === 1;
  return cards[(k * 2 + (odd ? 1 : 0)) % cards.length] ?? null;
}

/** A phone's post when a wall has its own list: phone k starts on post k and each landing moves it on a full wall. */
function cardAt(cards: readonly FeedCard[], k: number, shift: number, offset = 0): FeedCard | null {
  if (!cards.length) return null;
  return cards[(k + offset + shift * WALL_PHONES) % cards.length] ?? null;
}

export const WallFeed = memo(function WallFeed({ cards, rivals = [], handle, shifts, flashes }: { cards: readonly FeedCard[]; rivals?: readonly FeedCard[]; handle: string | null; shifts: readonly number[]; flashes: readonly number[] }) {
  const ks = Array.from({ length: WALL_PHONES }, (_, k) => k);
  const split = rivals.length > 0;
  const right = (k: number) => (split ? cardAt(rivals, k, shifts[k] ?? 0) : cardFor(cards, "R", k, shifts[k] ?? 0));
  // With competitors on the right, the left wall is the workspace's own; it borrows competitor posts only while it has none.
  const left = (k: number) => (!split ? cardFor(cards, "L", k, shifts[k] ?? 0) : cards.length ? cardAt(cards, k, shifts[k] ?? 0) : cardAt(rivals, k, shifts[k] ?? 0, WALL_PHONES));
  const v = (H - PHONE.z1) * Z;
  return (
    <g>
      <g transform={planeY(0, H)}>
        {ks.map((k) => (
          <g key={k} transform={`translate(${phoneStart(k) * S} ${v})`}>
            <Phone card={right(k)} flash={0} delay={k * 1.3} scan handle={handle} />
          </g>
        ))}
      </g>
      <g transform={planeX(0, D, H)}>
        {ks.map((k) => (
          <g key={k} transform={`translate(${(D - phoneStart(k) - PHONE.w) * S} ${v})`}>
            <Phone card={left(k)} flash={flashes[k] ?? 0} delay={k * 0.9 + 0.4} scan={false} handle={handle} />
          </g>
        ))}
      </g>
    </g>
  );
});

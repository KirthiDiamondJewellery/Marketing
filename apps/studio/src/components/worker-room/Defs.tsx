import { P } from "./palette";

/** Gradients shared by the whole room. Glows are gradients, never blur filters, so repaints stay cheap. */
export function Defs() {
  return (
    <defs>
      <radialGradient id="wr-glow-pink">
        <stop offset="0" stopColor="#fff" stopOpacity={0.95} />
        <stop offset="0.25" stopColor={P.pink} stopOpacity={0.7} />
        <stop offset="1" stopColor={P.magenta} stopOpacity={0} />
      </radialGradient>
      <radialGradient id="wr-glow-amber">
        <stop offset="0" stopColor="#fff" stopOpacity={0.9} />
        <stop offset="0.3" stopColor={P.amber} stopOpacity={0.7} />
        <stop offset="1" stopColor={P.amber} stopOpacity={0} />
      </radialGradient>
      <radialGradient id="wr-glow-floor">
        <stop offset="0" stopColor={P.pink} stopOpacity={0.5} />
        <stop offset="1" stopColor={P.magenta} stopOpacity={0} />
      </radialGradient>
      <radialGradient id="wr-glow-floor-amber">
        <stop offset="0" stopColor={P.amber} stopOpacity={0.42} />
        <stop offset="1" stopColor={P.amber} stopOpacity={0} />
      </radialGradient>
      <radialGradient id="wr-glow-room">
        <stop offset="0" stopColor={P.magenta} stopOpacity={0.3} />
        <stop offset="0.5" stopColor={P.violet} stopOpacity={0.1} />
        <stop offset="1" stopColor={P.violet} stopOpacity={0} />
      </radialGradient>
      <radialGradient id="wr-glow-violet">
        <stop offset="0" stopColor={P.violet} stopOpacity={0.4} />
        <stop offset="1" stopColor={P.violet} stopOpacity={0} />
      </radialGradient>
      <linearGradient id="wr-screen-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2a1850" />
        <stop offset="1" stopColor="#150b2a" />
      </linearGradient>
      <linearGradient id="wr-scan-fade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={P.pink} stopOpacity={0} />
        <stop offset="1" stopColor={P.pink} stopOpacity={0.45} />
      </linearGradient>
      <linearGradient id="wr-wall-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={P.wall} />
        <stop offset="0.7" stopColor={P.wallLow} />
        <stop offset="1" stopColor="#2a1440" />
      </linearGradient>
      <linearGradient id="wr-beam" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor={P.pink} stopOpacity={0.75} />
        <stop offset="1" stopColor={P.magenta} stopOpacity={0} />
      </linearGradient>
      <linearGradient id="wr-phone-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#000" stopOpacity={0.35} />
        <stop offset="0.22" stopColor="#000" stopOpacity={0} />
        <stop offset="0.6" stopColor="#000" stopOpacity={0} />
        <stop offset="1" stopColor="#000" stopOpacity={0.82} />
      </linearGradient>
      <linearGradient id="wr-phone-blank" x1="0" y1="0" x2="0.6" y2="1">
        <stop offset="0" stopColor="#2a1850" />
        <stop offset="0.55" stopColor="#1a0f30" />
        <stop offset="1" stopColor="#3a1450" />
      </linearGradient>
      <linearGradient id="wr-thumb-blank" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#5a3a9a" />
        <stop offset="1" stopColor="#2a1850" />
      </linearGradient>
      <linearGradient id="wr-core-ring" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={P.violet} />
        <stop offset="0.5" stopColor={P.pink} />
        <stop offset="1" stopColor={P.magenta} />
      </linearGradient>
      <linearGradient id="wr-holo-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={P.pink} stopOpacity={0.8} />
        <stop offset="1" stopColor={P.magenta} stopOpacity={0.4} />
      </linearGradient>
      <linearGradient id="wr-holo-cone" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={P.pink} stopOpacity={0.3} />
        <stop offset="1" stopColor={P.pink} stopOpacity={0} />
      </linearGradient>
    </defs>
  );
}

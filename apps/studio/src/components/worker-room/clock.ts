// One animation clock for the room's flying packets. It only runs while something is in the air.

export interface Clock {
  now: () => number;
  /** Calls fn on every frame with the clock time. Returns a function that stops it. */
  subscribe: (fn: (t: number) => void) => () => void;
}

export function createClock(): Clock {
  const subs = new Set<(t: number) => void>();
  let raf = 0;
  const frame = () => {
    const t = performance.now();
    subs.forEach((fn) => fn(t));
    raf = subs.size ? requestAnimationFrame(frame) : 0;
  };
  return {
    now: () => (typeof performance === "undefined" ? 0 : performance.now()),
    subscribe: (fn) => {
      subs.add(fn);
      if (!raf) raf = requestAnimationFrame(frame);
      return () => {
        subs.delete(fn);
        if (!subs.size && raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      };
    },
  };
}

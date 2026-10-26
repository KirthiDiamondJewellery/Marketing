import aosMark from "./aos-mark.png";

/**
 * The AttentionOS lockup: the AOS mark (design/brand/aos-mark.png, cropped from the supplied logo on its own black
 * background) beside the wordmark in Sora 600. `ringOnly` renders just the mark for the collapsed nav rail.
 */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a fixed-size brand asset, served as is (images are unoptimized)
    <img src={aosMark.src} width={size} height={size} alt="" aria-hidden className={`shrink-0 rounded-[22%] ${className ?? ""}`} />
  );
}

export function Wordmark({ ringOnly, className }: { ringOnly?: boolean; className?: string }) {
  if (ringOnly) return <Mark size={32} className={className} />;
  return (
    <span className={`inline-flex items-center gap-2 font-display text-[17px] font-semibold leading-none tracking-[-0.02em] text-fg ${className ?? ""}`} aria-label="AttentionOS">
      <Mark size={28} />
      <span aria-hidden>AttentionOS</span>
    </span>
  );
}

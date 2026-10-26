/**
 * The workspace's brand mark, generated from its name: an editorial monogram in Sora on a quiet disc.
 * Used at the centre of the command view and the agent map. Never colored: the brand's own content is the hero.
 */
export function brandInitials(name: string, max = 2): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "A";
  if (words.length === 1 || max === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
}

export function BrandMark({ name, size = 96, initials, className }: { name: string; size?: number; initials?: 1 | 2; className?: string }) {
  const text = brandInitials(name, initials ?? 2);
  const fs = size * (text.length > 1 ? 0.4 : 0.52);
  return (
    <span
      role="img"
      aria-label={name}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: "var(--surface-1)",
        boxShadow: "inset 0 0 0 1px var(--border-strong)",
        display: "inline-grid",
        placeItems: "center",
        flex: "none",
        position: "relative",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: fs,
          lineHeight: 1,
          letterSpacing: "-0.02em",
          color: "var(--text-primary)",
          transform: `translateY(${size * 0.02}px)`,
          userSelect: "none",
        }}
      >
        {text}
      </span>
      {/* A fine inner hairline, like a seal. */}
      <span aria-hidden style={{ position: "absolute", inset: size * 0.07, borderRadius: 999, boxShadow: "inset 0 0 0 1px var(--border)" }} />
    </span>
  );
}

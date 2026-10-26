"use client";

/** The Attention Signal (DESIGN §1): a 2px violet line marking where something is happening or needs the user. */
export function SignalLine({ orientation = "horizontal", pulse = false, className }: { orientation?: "horizontal" | "vertical"; pulse?: boolean; className?: string }) {
  const horizontal = orientation === "horizontal";
  return (
    <span
      aria-hidden
      className={[pulse ? "signal-pulse" : "", className ?? ""].join(" ").trim() || undefined}
      style={{
        display: "block",
        background: "var(--brand)",
        width: horizontal ? "100%" : 2,
        height: horizontal ? 2 : "100%",
        flex: "none",
      }}
    />
  );
}

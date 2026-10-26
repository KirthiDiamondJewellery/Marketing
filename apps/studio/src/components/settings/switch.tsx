"use client";
import { cn } from "@/components/ui";

/** On/off toggle (DESIGN §5: --radius-full). The label is for screen readers; the row shows the visible name. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-brand bg-brand" : "border-border-strong bg-surface-3",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-4 rounded-full transition-transform duration-[200ms] ease-[var(--ease-out)]",
          checked ? "translate-x-[18px] bg-on-brand" : "translate-x-[3px] bg-fg-2",
        )}
      />
    </button>
  );
}

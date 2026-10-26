import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type BadgeTone = "brand" | "neutral" | "success" | "warning" | "danger" | "info" | "gold";

const tones: Record<BadgeTone, string> = {
  brand: "bg-brand-tint text-on-tint",
  neutral: "bg-surface-3 text-fg-2",
  success: "bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success",
  warning: "bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-warning",
  danger: "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger",
  info: "bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-info",
  gold: "bg-[color-mix(in_srgb,var(--accent-gold)_14%,transparent)] text-gold",
};

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn("inline-flex h-[22px] items-center rounded-sm px-2 text-caption font-medium", tones[tone], className)}
      {...props}
    />
  );
}

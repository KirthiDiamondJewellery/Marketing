import type { ReactNode } from "react";
import { PlatformGlyph } from "@/motion/PlatformGlyph";
import { cn } from "@/components/ui";
import { platformLabel } from "./format";

/**
 * Small building blocks shared by the work surfaces. Server-safe (no hooks).
 */

export function PageHeader({ title, description, actions, className }: { title: string; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="text-h1 font-medium tracking-[-0.01em] text-fg">{title}</h1>
        {description ? <p className="mt-1.5 max-w-[60ch] text-body text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionHeader({ title, description, actions, id }: { title: string; description?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between" id={id}>
      <div className="min-w-0">
        <h2 className="text-h2 font-medium text-fg">{title}</h2>
        {description ? <p className="mt-0.5 text-small text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PlatformIcon({ platform, size = 16, className, label = false }: { platform: string; size?: number; className?: string; label?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-fg-2", className)} title={platformLabel(platform)}>
      <PlatformGlyph platform={platform} size={size} />
      {label ? <span className="text-small">{platformLabel(platform)}</span> : null}
    </span>
  );
}

export type StatusTone = "success" | "warning" | "danger" | "info" | "brand" | "neutral";

const DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  brand: "bg-brand",
  neutral: "bg-fg-3",
};

/** A status dot always paired with a label (DESIGN §12: never color alone). */
export function StatusDot({ tone, label, className, hideLabel }: { tone: StatusTone; label: string; className?: string; hideLabel?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-caption text-fg-2", className)} title={label}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}

/** Post status → tone + plain label. */
export function postStatus(status: string): { tone: StatusTone; label: string } {
  switch (status) {
    case "published":
      return { tone: "success", label: "Published" };
    case "scheduled":
      return { tone: "info", label: "Scheduled" };
    case "queued":
      return { tone: "info", label: "Queued" };
    case "publishing":
      return { tone: "brand", label: "Publishing" };
    case "assist":
      return { tone: "warning", label: "Post by hand" };
    case "failed":
      return { tone: "danger", label: "Failed" };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled" };
    default:
      return { tone: "neutral", label: "Draft" };
  }
}

export function EmptyState({ title, body, action, className }: { title: string; body: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center", className)}>
      <h3 className="text-h3 font-medium text-fg">{title}</h3>
      <p className="max-w-[44ch] text-small text-fg-2">{body}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** Label / value pairs for detail panels. */
export function Facts({ items, className }: { items: { label: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(96px,auto)_1fr] gap-x-6 gap-y-2.5 text-small", className)}>
      {items.map((it) => (
        <div key={it.label} className="contents">
          <dt className="text-fg-3">{it.label}</dt>
          <dd className="min-w-0 text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A thin, honest placeholder for a thumbnail we don't have (no stock imagery: DESIGN §10). */
export function ThumbPlaceholder({ label, platform, className }: { label?: string; platform?: string; className?: string }) {
  return (
    <div className={cn("relative flex items-end overflow-hidden bg-surface-2", className)}>
      <div
        aria-hidden
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, transparent 0 10px, color-mix(in srgb, var(--border) 55%, transparent) 10px 11px)",
        }}
      />
      {platform ? (
        <span className="absolute left-2 top-2 text-fg-3">
          <PlatformGlyph platform={platform} size={14} />
        </span>
      ) : null}
      {label ? <span className="relative line-clamp-3 p-2 text-caption text-fg-2">{label}</span> : null}
    </div>
  );
}

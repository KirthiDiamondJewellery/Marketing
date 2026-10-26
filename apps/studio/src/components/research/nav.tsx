import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";

/** Underlined section tabs driven by search params (server-rendered links, no client state). */
export function LinkTabs({ items, active, className }: { items: { key: string; label: string; href: string; count?: number | null }[]; active: string; className?: string }) {
  return (
    <nav aria-label="Sections" className={cn("-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>
      <ul className="flex min-w-max items-center gap-6 border-b border-border">
        {items.map((it) => {
          const on = it.key === active;
          return (
            <li key={it.key}>
              <Link
                href={it.href}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-11 items-center gap-2 text-[14px] font-medium transition-colors duration-[120ms]",
                  on ? "text-fg" : "text-fg-2 hover:text-fg",
                )}
              >
                {it.label}
                {it.count != null ? <span className={cn("tabular text-caption", on ? "text-fg-2" : "text-fg-3")}>{it.count}</span> : null}
                {on ? <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-fg" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A compact segmented filter (links). */
export function Segmented({ items, active, label }: { items: { key: string; label: ReactNode; href: string }[]; active: string; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-9 items-center rounded-md border border-border bg-surface-1 p-0.5">
      {items.map((it) => {
        const on = it.key === active;
        return (
          <Link
            key={it.key}
            href={it.href}
            scroll={false}
            aria-pressed={on}
            className={cn(
              "inline-flex h-full items-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium transition-colors duration-[120ms]",
              on ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg",
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}

/** Builds an href that keeps the other search params. */
export function hrefWith(base: string, params: Record<string, string | undefined | null>, patch: Record<string, string | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...patch })) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";

export const INSIGHT_TABS = [
  { href: "/insights", label: "Overview" },
  { href: "/insights/posts", label: "Posts" },
  { href: "/insights/working", label: "What's working" },
  { href: "/insights/timing", label: "When to post" },
  { href: "/insights/competitors", label: "Competitors" },
  { href: "/insights/funnel", label: "Funnel" },
  { href: "/insights/report", label: "Weekly report" },
] as const;

/** Section tabs for Insights. Keeps the chosen range (`?days=`) when moving between views. */
export function InsightsTabs() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const days = sp.get("days");
  const active = (href: string) => (href === "/insights" ? pathname === "/insights" : pathname.startsWith(href));
  return (
    <nav aria-label="Insights views" className="-mx-4 mb-8 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {INSIGHT_TABS.map((t) => (
          <li key={t.href}>
            <Link
              href={days && t.href !== "/insights/report" ? `${t.href}?days=${days}` : t.href}
              aria-current={active(t.href) ? "page" : undefined}
              className={cn(
                "relative inline-flex h-10 items-center px-3 text-[13px] font-medium transition-colors duration-[120ms]",
                active(t.href) ? "text-fg" : "text-fg-2 hover:text-fg",
              )}
            >
              {t.label}
              {active(t.href) ? <span aria-hidden className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-brand" /> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A small segmented control that writes one search param (range, window, metric). Server pages read it. */
export function Segmented({ param, options, current, label }: { param: string; options: { value: string; label: string }[]; current: string; label: string }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const href = (v: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set(param, v);
    return `${pathname}?${next.toString()}`;
  };
  return (
    <nav aria-label={label} className="inline-flex shrink-0 rounded-md border border-border bg-surface-1 p-0.5">
      {options.map((o) => (
        <Link
          key={o.value}
          href={href(o.value)}
          scroll={false}
          aria-current={o.value === current ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center whitespace-nowrap rounded-[8px] px-3 text-[13px] font-medium transition-colors duration-[120ms]",
            o.value === current ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

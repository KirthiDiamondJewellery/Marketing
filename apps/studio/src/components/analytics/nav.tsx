"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";

export const ANALYTICS_TABS = [
  { href: "/analytics", label: "Overview" },
  { href: "/analytics/posts", label: "Your posts" },
  { href: "/analytics/working", label: "What's working" },
  { href: "/analytics/competitors", label: "Competitors" },
] as const;

/** Section tabs for Analytics. Keeps the chosen range (`?days=`) when moving between views. */
export function AnalyticsTabs() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const days = sp.get("days");
  const active = (href: string) => (href === "/analytics" ? pathname === "/analytics" : pathname.startsWith(href));
  return (
    <nav aria-label="Analytics views" className="-mx-4 mb-8 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {ANALYTICS_TABS.map((t) => (
          <li key={t.href}>
            <Link
              href={days && t.href !== "/analytics/working" ? `${t.href}?days=${days}` : t.href}
              aria-current={active(t.href) ? "page" : undefined}
              className={cn(
                "relative inline-flex h-10 items-center px-3 text-[13px] font-medium transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:outline-brand",
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

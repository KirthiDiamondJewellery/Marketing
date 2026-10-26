"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, CalendarDays, FileText, House, Scissors, Search } from "lucide-react";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import { ChiefLauncher } from "@/components/chat/chief-launcher";
import { WakeTheTeam } from "@/motion";
import { CommandBar } from "./command-bar";
import { isActive, needsYou, SideNav } from "./nav";
import { SettingsApplied } from "./settings-applied";
import { ToastProvider } from "./toast";
import { Wordmark } from "./wordmark";
import { usePendingApprovals } from "./decided";

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

const MOBILE_TABS = [
  { href: "/", label: "Home", Icon: House },
  { href: "/scripts", label: "Scripts", Icon: FileText },
  { href: "/edit", label: "Edit", Icon: Scissors },
  { href: "/calendar", label: "Calendar", Icon: CalendarDays },
  { href: "/agents", label: "Agents", Icon: Bot },
] as const;

/** `g` then a letter jumps to a page. */
const CHORDS: Record<string, string> = { h: "/", s: "/scripts", e: "/edit", c: "/calendar", a: "/agents", n: "/analytics", b: "/brand", m: "/chat" };

/** The Studio shell: navigation on the left, the page, and the Chief of Staff in the bottom corner. */
export function OsShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { snapshot } = useLive();
  const [palette, setPalette] = useState(false);
  const [chat, setChat] = useState(false);
  const chord = useRef<{ key: string; at: number } | null>(null);

  const openChat = useCallback(() => setChat(true), []);
  const closeChat = useCallback(() => setChat(false), []);
  const closePalette = useCallback(() => setPalette(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        setPalette(true);
        return;
      }
      const prev = chord.current;
      if (prev?.key === "g" && Date.now() - prev.at < 900) {
        chord.current = null;
        const dest = CHORDS[e.key];
        if (dest) {
          e.preventDefault();
          router.push(dest);
        }
        return;
      }
      if (e.key === "g") chord.current = { key: "g", at: Date.now() };
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const counts = needsYou(usePendingApprovals(snapshot?.approvals));
  const working = snapshot?.agents.filter((a) => a.state === "working").length ?? 0;
  // The Agents view is made to be filmed: give it the whole width.
  const wide = isActive(pathname, "/agents");

  return (
    <ToastProvider>
      <SettingsApplied />
      <div className="flex min-h-dvh bg-bg">
        <SideNav />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-bg px-4 md:hidden">
            <Link href="/" aria-label="Home">
              <Wordmark />
            </Link>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setPalette(true)} className="grid size-11 place-items-center rounded-md text-fg-2" aria-label="Search or ask">
                <Search className="size-5" strokeWidth={1.5} />
              </button>
              <Link href="/agents" className="relative flex h-11 items-center gap-2 rounded-md px-2 text-small text-fg-2" aria-label="See your agents">
                <span aria-hidden className={cn("size-1.5 rounded-full", working ? "signal-pulse bg-brand" : "bg-fg-3")} />
                {working ? `${working} working` : "Team"}
              </Link>
            </div>
          </div>

          <main id="main" className={cn("mx-auto w-full flex-1 px-4 pb-32 pt-6 md:px-8 md:pb-24 md:pt-10", wide ? "max-w-[1600px]" : "max-w-[1200px]")}>
            {children}
          </main>
        </div>

        {/* Mobile bottom tab bar */}
        <nav aria-label="Studio" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg pb-[env(safe-area-inset-bottom)] md:hidden">
          <ul className="grid grid-cols-5">
            {MOBILE_TABS.map(({ href, label, Icon }) => {
              const active = isActive(pathname, href);
              const badge = counts[href] ?? 0;
              return (
                <li key={href}>
                  <Link href={href} aria-current={active ? "page" : undefined} className={cn("relative flex h-16 flex-col items-center justify-center gap-1 text-[11px]", active ? "text-fg" : "text-fg-3")}>
                    {active ? <span aria-hidden className="absolute inset-x-6 top-0 h-[2px] rounded-full bg-fg" /> : null}
                    <span className="relative">
                      <Icon className="size-5" strokeWidth={1.5} />
                      {badge ? (
                        <span className="absolute -right-2.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-medium text-on-brand tabular">{badge}</span>
                      ) : null}
                    </span>
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <CommandBar open={palette} onClose={closePalette} onOpenChat={openChat} />
        <ChiefLauncher open={chat} onOpen={openChat} onClose={closeChat} />
        {snapshot?.agents.length ? <WakeTheTeam agents={snapshot.agents} /> : null}
      </div>
    </ToastProvider>
  );
}

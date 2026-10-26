// Unfinished feature: Home's short list of waiting approvals with one-click approve. Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import type { ApprovalView } from "@/server/queries/approvals";
import { decideApprovalAction } from "@/server/actions/approvals";
import { Button } from "@/components/ui";
import { AgentMonogram, PlatformGlyph } from "@/motion";
import { who } from "@/components/shell/format";
import { RelTime } from "@/components/shell/rel-time";
import { useToast } from "@/components/shell/toast";
import { markDecided } from "@/components/shell/decided";

const KIND_VERB: Record<string, string> = { script: "wrote", edit: "cut", post: "scheduled", dm_reply: "drafted", comment_reply: "drafted" };

/** Top of the approvals queue on Home, each with one-click approve. */
export function WaitingList({ items, total }: { items: ApprovalView[]; total: number }) {
  const [done, setDone] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const visible = items.filter((a) => !done.includes(a.id));

  const approve = (a: ApprovalView) => {
    setBusy(a.id);
    start(async () => {
      const r = await decideApprovalAction(a.id, "approved");
      setBusy(null);
      if (!r.ok) return toast(r.error, "error");
      setDone((d) => [...d, a.id]);
      markDecided([a.id]);
      toast(`Approved. ${who(a.agent).name} takes it from here.`);
      router.refresh();
    });
  };

  if (!visible.length) {
    return (
      <div className="rounded-lg border border-border bg-surface-1 px-6 py-10 text-center">
        <p className="text-h3 font-medium text-fg">Queue clear</p>
        <p className="mt-1 text-small text-fg-2">Your agents are on it. New work shows up here the moment it's ready.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {visible.map((a) => {
            const w = who(a.agent);
            return (
              <motion.li
                key={a.id}
                layout
                exit={{ opacity: 0, x: 24, transition: { duration: 0.24, ease: [0.4, 0, 1, 1] } }}
                className="relative flex items-center gap-4 rounded-lg border border-border bg-surface-1 py-4 pl-5 pr-4"
              >
                <span aria-hidden className="absolute bottom-3 left-[-1px] top-3 w-[2px] bg-brand" />
                <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: "idle" }} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-caption text-fg-3">
                    <span className="text-fg-2">{w.name}</span>
                    <span>·</span>
                    <RelTime iso={a.requestedAt} prefix={`${KIND_VERB[a.kind] ?? "drafted"} `} />
                    <span className="ml-1 flex items-center gap-1.5 text-fg-3">
                      {a.platforms.slice(0, 3).map((p) => (
                        <PlatformGlyph key={p} platform={p} size={14} />
                      ))}
                    </span>
                  </div>
                  <Link href={`/approvals#${a.ref}`} className="mt-0.5 block truncate text-[15px] text-fg hover:underline hover:decoration-border-strong hover:underline-offset-4">
                    {a.title}
                  </Link>
                </div>
                <Button size="sm" variant="secondary" onClick={() => approve(a)} disabled={busy === a.id} aria-label={`Approve ${a.title}`}>
                  <Check className="size-4" strokeWidth={1.75} />
                  {busy === a.id ? "Approving" : "Approve"}
                </Button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {total > items.length ? (
        <Link href="/approvals" className="self-start text-small text-fg-2 underline decoration-border-strong underline-offset-4 hover:text-fg">
          {total - items.length} more in the queue
        </Link>
      ) : null}
    </div>
  );
}

// Unfinished feature: the list of videos sent back with notes while the new version is edited. Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "motion/react";
import { CircleAlert, RotateCcw } from "lucide-react";
import type { RevisingVideo } from "@/server/queries/approvals";
import { retryEditAction } from "@/server/actions/production";
import { Button } from "@/components/ui";
import { RelTime } from "@/components/shell/rel-time";
import { useToast } from "@/components/shell/toast";
import { AutoRefresh } from "@/components/production/auto-refresh";

/** Videos sent back with notes: "Editing v2…" until the new version replaces them in the queue. */
export function RevisingList({ items }: { items: RevisingVideo[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return null;
  return (
    <section aria-labelledby="revising" className="mb-8">
      <AutoRefresh active={items.some((i) => !i.error)} />
      <h2 id="revising" className="mb-3 text-h3 font-medium text-fg">
        Being edited <span className="ml-1 text-fg-3 tabular">{items.length}</span>
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((v) => (
          <li key={v.editId} className="flex items-center gap-4 rounded-lg border border-border bg-surface-1 p-3" data-revising={v.ref}>
            <div className="relative h-[85px] w-[48px] shrink-0 overflow-hidden rounded-[8px] border border-border bg-[#08060a]">
              {v.assetId ? <video src={`/api/media/${v.assetId}#t=0.5`} muted playsInline preload="metadata" className="h-full w-full object-cover opacity-60" /> : null}
              {!v.error ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-brand" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="truncate text-small font-medium text-fg">{v.title}</span>
                <span className="font-mono text-[11px] text-fg-3">{v.ref}</span>
              </p>
              {v.error ? (
                <p className="mt-1 flex items-start gap-1.5 text-small text-danger">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} /> {v.error}
                </p>
              ) : (
                <p className="mt-1 text-small text-fg">
                  Editing v{v.fromVersion + 1}…
                  <span className="text-fg-2"> {v.progress ? `· ${v.progress}` : "· applying your notes"}</span>
                </p>
              )}
              {v.notes ? <p className="mt-1 line-clamp-2 whitespace-pre-line text-caption text-fg-3">“{v.notes}”</p> : null}
              {!v.error ? (
                <div className="mt-2 h-[2px] w-full max-w-[280px] overflow-hidden rounded-full bg-surface-3">
                  <motion.div className="h-full w-1/3 bg-brand" animate={{ x: ["-100%", "300%"] }} transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }} />
                </div>
              ) : null}
            </div>
            <div className="hidden shrink-0 text-caption text-fg-3 sm:block">
              <RelTime iso={v.since} prefix="asked " />
            </div>
            {v.error ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === v.ref}
                onClick={async () => {
                  setBusy(v.ref);
                  const r = await retryEditAction(v.ref);
                  setBusy(null);
                  toast(r.ok ? r.message ?? "Retrying" : r.error, r.ok ? "ok" : "error");
                  router.refresh();
                }}
              >
                <RotateCcw className="size-3.5" strokeWidth={1.75} /> Retry
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

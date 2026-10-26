"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, CircleAlert, Scissors } from "lucide-react";
import type { CutReview } from "@/server/queries/edit";
import { decideApprovalAction } from "@/server/actions/approvals";
import { Button, Textarea } from "@/components/ui";
import { useToast } from "@/components/shell/toast";

/** A cut list waiting for the owner (only when "Review cuts before editing" is on). */
export function CutReviewCard({ c }: { c: CutReview }) {
  const router = useRouter();
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approved" | "revised") => {
    setBusy(true);
    setError(null);
    const r = await decideApprovalAction(c.approvalId, decision, decision === "revised" ? note : undefined);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast(decision === "approved" ? "Cuts approved. Your editor carries on." : "Sent. Your editor is redoing the cuts.");
    router.refresh();
  };

  return (
    <article className="rounded-lg border border-border bg-surface-1 p-5 max-sm:p-4" data-cut-review={c.approvalId}>
      <div className="flex items-start gap-3">
        <Scissors className="mt-1 size-4 shrink-0 text-fg-3" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="text-small text-fg-3">Cuts to check before editing</p>
          <h3 className="mt-0.5 text-[16px] font-medium leading-6 text-fg">{c.title}</h3>
          <p className="mt-1 text-small text-fg-2">{c.summary}</p>
          {c.flags.length ? (
            <ul className="mt-2 flex flex-col gap-1">
              {c.flags.map((f) => (
                <li key={f} className="flex items-start gap-2 text-small text-fg-2">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" strokeWidth={1.75} /> {f}
                </li>
              ))}
            </ul>
          ) : null}
          {changing ? (
            <div className="mt-3 flex flex-col gap-2">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="“Keep the second retake”, “don’t cut the laugh at the start”" className="min-h-16 bg-surface-1" aria-label="What to change in the cuts" />
            </div>
          ) : null}
          {error ? (
            <p className="mt-2 text-small text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {changing ? (
              <>
                <Button variant="ghost" onClick={() => setChanging(false)} disabled={busy}>
                  Back
                </Button>
                <Button variant="primary" onClick={() => decide("revised")} disabled={busy || !note.trim()}>
                  Send to your editor
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setChanging(true)} disabled={busy}>
                  Change the cuts
                </Button>
                <Button variant="primary" onClick={() => decide("approved")} disabled={busy}>
                  <Check className="size-4" strokeWidth={2} /> Cuts look good
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

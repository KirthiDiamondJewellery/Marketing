// Unfinished feature: the list of recently decided approvals (the sign-off paper trail). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import type { ApprovalView } from "@/server/queries/approvals";
import { ApprovalCard } from "./approval-card";

/** Recently decided approvals, newest first: the paper trail of what you signed off. */
export function DecidedList({ items, handles, tz }: { items: ApprovalView[]; handles: Record<string, string>; tz?: string }) {
  if (!items.length) return <p className="py-16 text-center text-small text-fg-2">Nothing decided yet. Approvals you sign off show up here.</p>;
  return (
    <div className="flex flex-col gap-6">
      {items.map((item) => (
        <ApprovalCard key={item.id} item={item} handles={handles} tz={tz} focused={false} busy={false} onFocus={() => {}} onDecide={async () => false} />
      ))}
    </div>
  );
}

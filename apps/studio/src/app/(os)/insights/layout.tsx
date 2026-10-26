import { Suspense, type ReactNode } from "react";
import { PageHeader } from "@/components/content/shared";
import { InsightsTabs } from "@/components/insights/nav";

export const dynamic = "force-dynamic";

/** Insights: one header, section tabs, and each view as its own route. */
export default function InsightsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Insights" description="How your posts are doing against your own normal, what's driving it and what it's worth. Every number here is the one your agents see." className="mb-6" />
      <Suspense fallback={<div className="mb-8 h-10 border-b border-border" />}>
        <InsightsTabs />
      </Suspense>
      {children}
    </>
  );
}

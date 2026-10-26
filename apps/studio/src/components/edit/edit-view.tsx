"use client";
import { MotionConfig } from "motion/react";
import type { EditPageData } from "@/server/queries/edit";
import type { TrialSummary } from "@/server/queries/trial-reels";
import { TrialReelsProvider, TrialReelsSection } from "@/components/trial-reels/trial-reels";
import { AutoRefresh } from "@/components/production/auto-refresh";
import { UploadZone } from "./upload-zone";
import { EditingList } from "./editing-list";
import { ReviewCard } from "./review-card";
import { CutReviewCard } from "./cut-review";
import { DoneList } from "./done-list";

/** The Edit page, top to bottom: upload, being edited, ready for you, recently done, trial reels. */
export function EditView({ data, trial }: { data: EditPageData; trial?: TrialSummary }) {
  const inFlight =
    data.editing.some((r) => r.state !== "failed") ||
    data.takes.some((t) => t.status === "matching") ||
    data.done.some((d) => d.releaseStatus === "approved" || d.releaseStatus === "scheduling") ||
    Boolean(trial?.batches.some((b) => b.status === "queued" || b.status === "rendering" || b.progress));
  const waiting = data.review.length + data.cuts.length;
  const empty = !waiting && !data.editing.length && !data.takes.length;

  return (
    <MotionConfig reducedMotion="user">
      <TrialReelsProvider>
      <AutoRefresh active={inFlight} />
      <div className="flex flex-col gap-10">
        <UploadZone takes={data.takes} scripts={data.scripts} roomy={empty || (!waiting && !data.editing.length)} trialOn={Boolean(trial?.ready)} />

        <EditingList rows={data.editing} workerStale={data.workerStale} />

        <section aria-labelledby="edit-ready">
          <h2 id="edit-ready" className="mb-3 text-h3 font-medium text-fg">
            Ready for you {waiting ? <span className="ml-1 text-fg-3 tabular">{waiting}</span> : null}
          </h2>
          {waiting ? (
            <div className="flex flex-col gap-4">
              {data.cuts.map((c) => (
                <CutReviewCard key={c.approvalId} c={c} />
              ))}
              {data.review.map((v) => (
                <ReviewCard key={v.approvalId} v={v} tz={data.tz} instagramAutopost={data.instagramAutopost} />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-5 py-6 text-small text-fg-2">
              {data.editing.length
                ? "Nothing to watch yet. Finished videos show up here as soon as your editor is done."
                : "Nothing to watch yet. Upload footage above and the finished video lands here for you to check."}
            </p>
          )}
        </section>

        <DoneList items={data.done} trialReels={Boolean(trial?.ready)} />

        {trial ? <TrialReelsSection summary={trial} /> : null}
      </div>
      </TrialReelsProvider>
    </MotionConfig>
  );
}

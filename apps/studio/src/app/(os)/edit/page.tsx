import type { Metadata } from "next";
import { getEditPage } from "@/server/queries/edit";
import { trialSummary } from "@/server/queries/trial-reels";
import { PageHeader } from "@/components/shell/page-header";
import { EditView } from "@/components/edit/edit-view";
import { EditSettings } from "@/components/edit/edit-settings";

export const metadata: Metadata = { title: "Edit" };
export const dynamic = "force-dynamic";

export default async function EditPage() {
  const [data, trial] = await Promise.all([getEditPage(), trialSummary().catch(() => ({ ready: false, batches: [], cleanUploads: [] }))]);
  const ready = data.review.length + data.cuts.length;
  const editing = data.editing.filter((r) => r.state !== "failed").length;
  const parts = [ready ? `${ready} ready for you` : null, editing ? `${editing} being edited` : null].filter(Boolean);
  return (
    <div className="@container">
      <PageHeader
        title="Edit"
        description={
          parts.length
            ? `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())}. ${ready ? "Watch each one, then say if it looks good or what to change." : "Finished videos show up here for you to check."}`
            : "Upload your footage and your editor cuts it. You watch it, say what to change, then schedule it, download it or keep it ready to post."
        }
        actions={<EditSettings reviewCuts={data.reviewCuts} />}
      />
      <EditView data={data} trial={trial} />
    </div>
  );
}

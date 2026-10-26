import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { LiveProvider } from "@/lib/use-live";
import type { Snapshot } from "@/lib/live";
import { buildSnapshot } from "@/server/snapshot";
import { StudioSetupError, workspace } from "@/server/workspace";
import { OsShell } from "@/components/shell/os-shell";
import { UploadRoot } from "@/components/upload/upload-root";
import { ReelOverlayHost, ReelProvider } from "@/components/reel";
import { SetupNeeded } from "@/components/shell/setup-needed";
import { needsOnboarding } from "@/server/onboarding";

export const dynamic = "force-dynamic";

/** The OS shell: one live snapshot shared by every surface, reel mode, and the three-zone layout. */
export default async function OsLayout({ children }: { children: ReactNode }) {
  // First run: the setup wizard (/setup) until onboarding is finished or skipped.
  if (await needsOnboarding().catch(() => false)) redirect("/setup");
  let initial: Snapshot | null = null;
  try {
    initial = await buildSnapshot(workspace());
  } catch (e) {
    if (e instanceof StudioSetupError) return <SetupNeeded message={e.message} />;
    console.error("[studio] could not load the workspace:", e);
    return <SetupNeeded message="Studio couldn't reach your workspace database. Check that Postgres is running, then reload." />;
  }
  return (
    <LiveProvider initial={initial}>
      <ReelProvider>
        <OsShell>
          <UploadRoot>{children}</UploadRoot>
        </OsShell>
        <ReelOverlayHost />
      </ReelProvider>
    </LiveProvider>
  );
}

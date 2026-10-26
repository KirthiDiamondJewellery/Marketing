import { SetupNeeded } from "@/components/shell/setup-needed";
import { SetupWizard } from "@/components/onboarding/wizard";
import { getSetupView } from "@/server/queries/onboarding";
import { StudioSetupError } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * First-run setup: a resumable, full-screen wizard. The saved step (`onboarding:state` in settings) decides what shows;
 * `?step=<id>` opens a specific step (links from the step rail and from Settings).
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ step?: string | string[] }> }) {
  const { step } = await searchParams;
  try {
    const view = await getSetupView(Array.isArray(step) ? step[0] : step);
    return <SetupWizard view={view} />;
  } catch (e) {
    if (e instanceof StudioSetupError) return <SetupNeeded message={e.message} />;
    console.error("[studio] setup couldn't load:", e);
    return <SetupNeeded message="Studio couldn't reach your workspace database. Check that Postgres is running, then reload." />;
  }
}

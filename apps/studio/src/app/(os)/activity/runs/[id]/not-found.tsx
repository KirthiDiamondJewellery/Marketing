import Link from "next/link";
import { buttonClass } from "@/components/ui";

export default function RunNotFound() {
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <h1 className="text-h2 font-medium text-fg">That run isn't here anymore</h1>
      <p className="mt-2 max-w-sm text-small text-fg-2">It may have been cleared with old history, or the workspace was reset.</p>
      <Link href="/activity" className={buttonClass("secondary", "md", "mt-6")}>
        Back to activity
      </Link>
    </div>
  );
}

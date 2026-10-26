import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { fmtX } from "@/components/content/format";
import { Badge } from "@/components/ui";
import type { Versus } from "@/server/queries/analytics";

/** "Above your normal" / "Below your normal" marker. Nothing for posts near normal or still settling. */
export function VersusBadge({ versus, x }: { versus: Versus; x: number | null }) {
  if (versus === "above") {
    return (
      <Badge tone="success" title={`${fmtX(x)} your normal`}>
        <ArrowUpRight className="mr-0.5 size-3" aria-hidden />
        Above your normal
      </Badge>
    );
  }
  if (versus === "below") {
    return (
      <Badge tone="warning" title={`${fmtX(x)} your normal`}>
        <ArrowDownRight className="mr-0.5 size-3" aria-hidden />
        Below your normal
      </Badge>
    );
  }
  return null;
}

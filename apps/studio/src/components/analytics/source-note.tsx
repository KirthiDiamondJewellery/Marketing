import { fmtDate, fmtRelative, handle, platformLabel } from "@/components/content/format";
import type { Sources } from "@/server/queries/analytics";

/** Where this page's numbers come from, in one line: never a number without its source and date. */
export function SourceNote({ sources, tz }: { sources: Sources; tz: string }) {
  const parts: string[] = [];
  if (sources.scan) {
    const who = sources.scan.accounts.map((a) => `${handle(a.handle)} on ${platformLabel(a.platform)}`).join(", ");
    parts.push(`From your last scan, ${fmtDate(sources.scan.at, tz, { month: "short", day: "numeric" })}: ${sources.scan.posts} post${sources.scan.posts === 1 ? "" : "s"} from ${who}`);
  }
  if (sources.measured.posts) {
    parts.push(`${sources.measured.posts} published post${sources.measured.posts === 1 ? "" : "s"} measured${sources.measured.lastCapturedAt ? `, numbers read ${fmtRelative(sources.measured.lastCapturedAt)}` : ""}`);
  }
  if (sources.competitorsAt) parts.push(`competitors scanned ${fmtRelative(sources.competitorsAt)}`);
  if (!parts.length) return null;
  const text = parts.join(" · ");
  return <p className="text-caption text-fg-3">{text.charAt(0).toUpperCase() + text.slice(1)}.</p>;
}

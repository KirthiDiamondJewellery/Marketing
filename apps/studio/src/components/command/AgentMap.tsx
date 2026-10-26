// Unfinished feature: the compact agent map, used only by the unfinished Home team panel. Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import { Orbit } from "./Orbit";

/**
 * Compact agent map for the Home page (fits a ~600×420 panel): the brand at the centre, the team on its two tracks, live
 * relay comets between them. Each agent links to its profile. Must render inside <LiveProvider>.
 */
export function AgentMap({ className, height = 420 }: { className?: string; height?: number | string }) {
  return (
    <div className={className} style={{ position: "relative", width: "100%", height, minHeight: 280 }}>
      <Orbit variant="compact" insets={{ top: 12, right: 12, bottom: 12, left: 12 }} />
    </div>
  );
}

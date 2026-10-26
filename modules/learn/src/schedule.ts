/**
 * Snapshot schedule: metrics are captured 1h, 24h, 72h, 7d and 30d after a post goes live.
 * Each label has a capture window; once the window has passed without a capture the label is skipped
 * rather than filled late (a "1h" number read at hour 20 would be misleading).
 */

export const SCHEDULED_LABELS = ["1h", "24h", "72h", "7d", "30d"] as const;
export type ScheduledLabel = (typeof SCHEDULED_LABELS)[number];

export const SNAPSHOT_SCHEDULE: Record<ScheduledLabel, { afterH: number; windowH: number }> = {
  "1h": { afterH: 1, windowH: 2 },
  "24h": { afterH: 24, windowH: 12 },
  "72h": { afterH: 72, windowH: 24 },
  "7d": { afterH: 168, windowH: 48 },
  "30d": { afterH: 720, windowH: 120 },
};

const H = 3_600_000;

/** Labels that should be captured now for a post published at `publishedAt`. */
export function dueSnapshots(publishedAt: Date, now: Date, taken: ReadonlySet<string>): ScheduledLabel[] {
  const ageH = (now.getTime() - publishedAt.getTime()) / H;
  return SCHEDULED_LABELS.filter((l) => {
    const { afterH, windowH } = SNAPSHOT_SCHEDULE[l];
    return !taken.has(l) && ageH >= afterH && ageH <= afterH + windowH;
  });
}

/** When the next label becomes due (null when the schedule is finished). */
export function nextSnapshotAt(publishedAt: Date, now: Date, taken: ReadonlySet<string>): { label: ScheduledLabel; at: Date } | null {
  for (const l of SCHEDULED_LABELS) {
    if (taken.has(l)) continue;
    const { afterH, windowH } = SNAPSHOT_SCHEDULE[l];
    const at = new Date(publishedAt.getTime() + afterH * H);
    if (now.getTime() <= at.getTime() + windowH * H) return { label: l, at };
  }
  return null;
}

/** Hours after publishing at which the last scheduled label closes; older posts need no more captures. */
export const SCHEDULE_HORIZON_H = SNAPSHOT_SCHEDULE["30d"].afterH + SNAPSHOT_SCHEDULE["30d"].windowH;

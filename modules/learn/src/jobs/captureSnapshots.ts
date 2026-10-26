import { z } from "zod";
import { defineNativeJob, type WorkspaceContext } from "@attentionos/core";
import { syncOwnMetrics } from "@attentionos/module-research";
import { computeOwnScores } from "../metrics.ts";
import { dueSnapshots, SCHEDULE_HORIZON_H, type ScheduledLabel } from "../schedule.ts";

export type CaptureResult = { due: number; captured: number; missing: number; skipped?: "no_provider" | "nothing_due" };

/** Posts still inside the 30-day schedule, with the labels they already have. */
export async function postsInSchedule(ws: WorkspaceContext): Promise<{ postId: string; publishedAt: Date; taken: Set<string> }[]> {
  const since = new Date(ws.now().getTime() - SCHEDULE_HORIZON_H * 3_600_000);
  const rows = await ws.sql`
    select p.id, p.published_at, coalesce(array_agg(distinct m.snapshot) filter (where m.snapshot is not null), '{}') as labels
      from posts p left join post_metrics m on m.post_id = p.id and m.workspace_id = p.workspace_id
     where p.workspace_id = ${ws.id} and p.status = 'published' and p.published_at >= ${since}
     group by p.id, p.published_at`;
  return rows.map((r) => ({ postId: r.id as string, publishedAt: r.published_at as Date, taken: new Set(r.labels as string[]) }));
}

/**
 * Snapshot scheduler: finds posts with a 1h/24h/72h/7d/30d capture due, pulls fresh numbers from
 * the analytics provider once, and writes one labelled `post_metrics` row per due label.
 */
export async function captureDueSnapshots(ws: WorkspaceContext): Promise<CaptureResult> {
  const now = ws.now();
  const due: { postId: string; publishedAt: Date; label: ScheduledLabel }[] = [];
  for (const p of await postsInSchedule(ws)) for (const label of dueSnapshots(p.publishedAt, now, p.taken)) due.push({ postId: p.postId, publishedAt: p.publishedAt, label });
  if (due.length === 0) return { due: 0, captured: 0, missing: 0, skipped: "nothing_due" };
  if (!ws.providers.ownAnalytics) return { due: due.length, captured: 0, missing: due.length, skipped: "no_provider" };

  const oldest = new Date(Math.min(...due.map((d) => d.publishedAt.getTime())) - 3_600_000);
  const sync = await syncOwnMetrics(ws, { label: "latest", since: oldest.toISOString() });
  const latestByPost = new Map<string, number>();
  for (const w of sync.written) latestByPost.set(w.postId, w.snapshotId);

  let captured = 0;
  for (const d of due) {
    const source = latestByPost.get(d.postId);
    if (!source) continue;
    await ws.sql`
      insert into post_metrics (workspace_id, post_id, captured_at, snapshot, views, reach, likes, comments, shares, saves, follows,
                                profile_visits, avg_watch_time_s, skip_rate, completion_rate, leads, raw)
      select workspace_id, post_id, captured_at, ${d.label}, views, reach, likes, comments, shares, saves, follows,
             profile_visits, avg_watch_time_s, skip_rate, completion_rate, leads, raw
        from post_metrics where id = ${source} and workspace_id = ${ws.id}`;
    captured++;
  }
  if (captured > 0) await computeOwnScores(ws);
  return { due: due.length, captured, missing: due.length - captured };
}

export const captureSnapshotsJob = defineNativeJob({
  kind: "native",
  id: "learn.capture-snapshots",
  agent: "analyst",
  description: "Captures each post's numbers 1 hour, 24 hours, 3 days, 7 days and 30 days after it goes live.",
  input: z.object({}),
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const r = await captureDueSnapshots(ctx.ws);
    if (r.skipped === "no_provider") await ctx.progress(`${r.due} snapshot${r.due === 1 ? " is" : "s are"} due but no analytics provider is connected`);
    else if (r.captured) await ctx.progress(`Captured ${r.captured} snapshot${r.captured === 1 ? "" : "s"}${r.missing ? `; ${r.missing} post${r.missing === 1 ? " wasn't" : "s weren't"} in the provider's data yet` : ""}`);
    return r;
  },
});

import "server-only";
import { workspace } from "@/server/workspace";

/**
 * Home's at-a-glance numbers: where every piece of content is between "idea" and "posted", plus what goes out next.
 * Each count is read on its own, so a module that's switched off (no production tables yet) shows 0, not an error.
 */

export type Pipeline = {
  scripts: { writing: number; needsOk: number; readyToFilm: number; filmed: number };
  videos: { editing: number; needsReview: number; readyToPost: number };
  posts: { scheduledWeek: number; postedWeek: number; failedWeek: number };
  next: { id: string; platform: string; at: string; title: string | null; status: string }[];
};

async function count(fn: () => Promise<{ n: number }[]>): Promise<number> {
  try {
    return (await fn())[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function getPipeline(): Promise<Pipeline> {
  const ws = workspace();
  const { sql, id } = ws;
  const [writing, needsOk, readyToFilm, filmed, editing, needsReview, readyToPost, scheduledWeek, postedWeek, failedWeek, next] = await Promise.all([
    count(() => sql`select count(*)::int as n from agent_runs where workspace_id = ${id} and job_id = 'scripting.write-script' and status in ('queued', 'running')`),
    count(() => sql`select count(*)::int as n from approvals where workspace_id = ${id} and status = 'pending' and kind = 'script'`),
    count(() => sql`select count(*)::int as n from content where workspace_id = ${id} and status = 'scripted' and kind not in ('text', 'carousel')`),
    count(() => sql`select count(*)::int as n from content where workspace_id = ${id} and status = 'filming'`),
    count(() => sql`select count(*)::int as n from edit_jobs where workspace_id = ${id} and status in ('queued', 'prepping', 'planning', 'rendering', 'qc')`),
    count(() => sql`select count(*)::int as n from approvals where workspace_id = ${id} and status = 'pending' and kind = 'edit'`),
    count(() => sql`select count(*)::int as n from production_releases where workspace_id = ${id} and status = 'ready'`),
    count(() => sql`select count(*)::int as n from posts where workspace_id = ${id} and status in ('queued', 'scheduled', 'assist') and scheduled_at between now() and now() + interval '7 days'`),
    count(() => sql`select count(*)::int as n from posts where workspace_id = ${id} and status = 'published' and published_at > now() - interval '7 days'`),
    count(() => sql`select count(*)::int as n from posts where workspace_id = ${id} and status = 'failed' and updated_at > now() - interval '7 days'`),
    sql<{ id: string; platform: string; at: Date; title: string | null; status: string }[]>`
      select p.id, p.platform, p.scheduled_at as at, coalesce(c.title, left(p.caption, 80)) as title, p.status
        from posts p left join content c on c.id = p.content_id
       where p.workspace_id = ${id} and p.status in ('queued', 'scheduled', 'assist', 'publishing') and p.scheduled_at >= now() - interval '1 hour'
       order by p.scheduled_at asc limit 5`.catch(() => []),
  ]);
  return {
    scripts: { writing, needsOk, readyToFilm, filmed },
    videos: { editing, needsReview, readyToPost },
    posts: { scheduledWeek, postedWeek, failedWeek },
    next: next.map((p) => ({ id: p.id, platform: p.platform, at: new Date(p.at).toISOString(), title: p.title, status: p.status })),
  };
}

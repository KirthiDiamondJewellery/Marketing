import type { OwnAnalytics, PostMetricsSnapshot, WorkspaceContext } from "@attentionos/core";
import { jsonb } from "@attentionos/core";
import { transcriptFingerprint } from "@attentionos/scoring";
import { count } from "../lib/db.ts";

export const SNAPSHOT_LABELS = ["1h", "24h", "72h", "7d", "30d", "latest", "import"] as const;
export type SnapshotLabel = (typeof SNAPSHOT_LABELS)[number];

export type OwnSyncResult = {
  accounts: number;
  snapshots: number;
  postsCreated: number;
  /** post id → snapshot written (used by learn to label due snapshots). */
  written: { postId: string; platformPostId: string; publishedAt: string | null; snapshotId: number }[];
};

type AccountRow = { id: string | null; providerAccountId: string; platform: string | null };

async function accountsFor(ws: WorkspaceContext, analytics: OwnAnalytics, only?: string[]): Promise<AccountRow[]> {
  const rows = await ws.sql`
    select id, provider_account_id, platform from social_accounts
     where workspace_id = ${ws.id} and status = 'connected'
     order by platform, handle`;
  const accounts = rows
    .map((r) => ({ id: r.id as string, providerAccountId: r.provider_account_id as string, platform: r.platform as string }))
    .filter((a) => !only || only.includes(a.id!));
  // Providers that read the whole workspace at once (CSV imports) work without connected accounts.
  if (accounts.length === 0 && !only) return [{ id: null, providerAccountId: analytics.id === "csv" ? "*" : "me", platform: null }];
  return accounts;
}

/** Finds the post a snapshot belongs to, creating an imported `posts` row for history published outside AttentionOS. */
async function resolvePost(ws: WorkspaceContext, s: PostMetricsSnapshot, account: AccountRow, provider: string): Promise<{ id: string; created: boolean; publishedAt: string | null }> {
  const [byId] = await ws.sql`
    select id, published_at from posts
     where workspace_id = ${ws.id} and platform = ${s.platform}
       and (platform_post_id = ${s.platformPostId} ${s.providerPostId ? ws.sql`or provider_post_id = ${s.providerPostId}` : ws.sql``}
            ${s.url ? ws.sql`or url = ${s.url}` : ws.sql``})
     order by (platform_post_id = ${s.platformPostId}) desc, created_at
     limit 1`;
  if (byId) {
    await ws.sql`
      update posts set platform_post_id = coalesce(platform_post_id, ${s.platformPostId}),
                       published_at = coalesce(published_at, ${s.publishedAt ?? null}),
                       url = coalesce(url, ${s.url ?? null}),
                       status = case when status in ('scheduled', 'publishing', 'queued') then 'published' else status end,
                       updated_at = ${ws.now()}
       where workspace_id = ${ws.id} and id = ${byId.id as string}`;
    return { id: byId.id as string, created: false, publishedAt: (byId.published_at as Date | null)?.toISOString() ?? s.publishedAt ?? null };
  }
  const [row] = await ws.sql`
    insert into posts (workspace_id, social_account_id, platform, provider, platform_post_id, provider_post_id, status, published_at, url, caption, idempotency_key, payload)
    values (${ws.id}, ${account.id}, ${s.platform}, ${provider}, ${s.platformPostId}, ${s.providerPostId ?? null}, 'published',
            ${s.publishedAt ?? null}, ${s.url ?? null}, ${s.caption ?? null}, ${`import:${s.platform}:${s.platformPostId}`},
            ${jsonb(ws.sql, { imported: true, ...(typeof s.durationS === "number" ? { durationS: s.durationS } : {}) })})
    on conflict (workspace_id, idempotency_key) do update set updated_at = excluded.updated_at
    returning id, (xmax = 0) as inserted`;
  return { id: row!.id as string, created: Boolean(row!.inserted), publishedAt: s.publishedAt ?? null };
}

export async function insertMetricsSnapshot(ws: WorkspaceContext, postId: string, s: PostMetricsSnapshot, label: SnapshotLabel, xScore?: number | null): Promise<number> {
  const raw = { ...(s.raw ?? {}), ...(typeof s.durationS === "number" ? { durationS: s.durationS } : {}) };
  const [row] = await ws.sql`
    insert into post_metrics (workspace_id, post_id, captured_at, snapshot, views, reach, likes, comments, shares, saves, follows,
                              profile_visits, avg_watch_time_s, skip_rate, completion_rate, x_score, raw)
    values (${ws.id}, ${postId}, ${s.capturedAt}, ${label}, ${count(s.views)}, ${count(s.reach)}, ${count(s.likes)}, ${count(s.comments)},
            ${count(s.shares)}, ${count(s.saves)}, ${count(s.follows)}, ${count(s.profileVisits)}, ${s.avgWatchTimeS ?? null},
            ${s.skipRate ?? null}, ${s.completionRate ?? null}, ${xScore ?? null}, ${Object.keys(raw).length ? jsonb(ws.sql, raw) : null})
    returning id`;
  return Number(row!.id);
}

/**
 * Own-account sync: pulls posts + metrics from the OwnAnalytics provider and appends `post_metrics`
 * snapshots matched by platform post id (or provider id / URL). Posts published before AttentionOS get an
 * imported `posts` row so metrics capture works from day one.
 */
export async function syncOwnMetrics(
  ws: WorkspaceContext,
  opts: { label?: SnapshotLabel; since?: string; accountIds?: string[]; analytics?: OwnAnalytics } = {},
): Promise<OwnSyncResult> {
  const analytics = opts.analytics ?? ws.providers.ownAnalytics;
  const result: OwnSyncResult = { accounts: 0, snapshots: 0, postsCreated: 0, written: [] };
  if (!analytics) return result;
  const label = opts.label ?? (analytics.id === "csv" ? "import" : "latest");
  for (const account of await accountsFor(ws, analytics, opts.accountIds)) {
    result.accounts++;
    const snaps = await analytics.listPostMetrics(account.providerAccountId, opts.since ? { since: opts.since } : {});
    for (const s of snaps) {
      if (account.platform && s.platform !== account.platform) continue;
      const post = await resolvePost(ws, s, account, analytics.id);
      if (post.created) result.postsCreated++;
      const snapshotId = await insertMetricsSnapshot(ws, post.id, s, label);
      result.snapshots++;
      result.written.push({ postId: post.id, platformPostId: s.platformPostId, publishedAt: post.publishedAt, snapshotId });
    }
  }
  return result;
}

/**
 * Collapses trial-reel variants: posts on the same platform whose transcripts share a fingerprint
 * are one piece of content. The earliest published stays the main post; later ones get `variant_of`.
 * Transcripts come from the approved script of the linked content, or `payload.transcript` on the post.
 */
export async function collapseTrialVariants(ws: WorkspaceContext): Promise<number> {
  const rows = await ws.sql`
    select p.id, p.platform, p.published_at, p.variant_of,
           coalesce(p.payload->>'transcript',
                    (select s.body from scripts s where s.content_id = p.content_id and s.workspace_id = p.workspace_id
                      order by (s.status = 'approved') desc, s.version desc limit 1)) as transcript
      from posts p
     where p.workspace_id = ${ws.id} and p.status = 'published'
     order by p.published_at nulls last, p.created_at`;
  const mainByKey = new Map<string, string>();
  let collapsed = 0;
  for (const r of rows) {
    const fp = transcriptFingerprint(r.transcript as string | null);
    if (fp.length < 40) continue; // too short to be a reliable fingerprint
    const key = `${r.platform as string}\u0000${fp}`;
    const main = mainByKey.get(key);
    if (!main) {
      mainByKey.set(key, r.id as string);
      continue;
    }
    if (r.variant_of !== main) {
      await ws.sql`update posts set variant_of = ${main}, updated_at = ${ws.now()} where workspace_id = ${ws.id} and id = ${r.id as string}`;
      collapsed++;
    }
  }
  return collapsed;
}

export async function ownSyncStats(ws: WorkspaceContext): Promise<{ posts: number; lastCapturedAt: string | null }> {
  const [r] = await ws.sql`
    select (select count(*)::int from posts where workspace_id = ${ws.id} and status = 'published') as posts,
           (select max(captured_at) from post_metrics where workspace_id = ${ws.id}) as last`;
  return { posts: Number(r?.posts ?? 0), lastCapturedAt: (r?.last as Date | null)?.toISOString() ?? null };
}

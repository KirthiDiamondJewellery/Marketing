import { captionsSchema, composeCaption, type Captions } from "@attentionos/guardrails";
import type { CtaType, MediaRef, Platform, PlatformOptions, PublishRequest, SocialAccount, WorkspaceContext } from "@attentionos/core";

/** Database access for publishing. Every query filters by workspace_id. */

export type PostStatus = "draft" | "queued" | "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "assist";

/** What we keep in `posts.payload` so a post can be re-validated, resent or explained later. */
export type PostPayload = {
  request: PublishRequest;
  mode: "auto" | "assist";
  title: string;
  cta?: { type: CtaType | string | null; keyword?: string | null };
  trackedUrl?: string;
  /** Set right before the provider call; a crash after this leaves an ambiguous post (see publish-due). */
  sendingAt?: string;
  assistNotifiedAt?: string;
  crossPostOf?: string;
  trial?: { variation: number; seed: string };
  isKey?: boolean;
  /** Set when the post came from a week plan that is approved as a whole. */
  weekPlanId?: string;
  /** Set when the post belongs to a batch a person approved as a whole (e.g. a day of trial reels). */
  planApproval?: { subjectType: string; subjectId: string };
};

export type PostRow = {
  id: string;
  content_id: string | null;
  social_account_id: string | null;
  platform: Platform;
  provider: string;
  provider_post_id: string | null;
  platform_post_id: string | null;
  status: PostStatus;
  scheduled_at: Date | null;
  published_at: Date | null;
  url: string | null;
  caption: string | null;
  utm_content: string | null;
  short_link: string | null;
  is_trial: boolean;
  variant_of: string | null;
  idempotency_key: string;
  payload: PostPayload | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AccountRow = SocialAccount & { id: string };

/** Refreshes `social_accounts` from the publisher (the accounts snapshot payloads are checked against). */
export async function syncAccounts(ws: WorkspaceContext): Promise<AccountRow[]> {
  const publisher = ws.providers.publisher;
  if (!publisher) return [];
  const accounts = await publisher.listAccounts();
  const provider = publisher.id;
  for (const a of accounts) {
    await ws.sql`
      insert into social_accounts (workspace_id, provider, provider_account_id, platform, handle, display_name, status, updated_at)
      values (${ws.id}, ${provider}, ${a.providerAccountId}, ${a.platform}, ${a.handle}, ${a.displayName ?? null}, ${a.status}, now())
      on conflict (workspace_id, provider, provider_account_id) do update
        set platform = excluded.platform, handle = excluded.handle, display_name = excluded.display_name,
            status = excluded.status, updated_at = now()`;
  }
  // Accounts the provider no longer lists can't be posted to.
  const ids = accounts.map((a) => a.providerAccountId);
  await ws.sql`
    update social_accounts set status = 'disabled', updated_at = now()
     where workspace_id = ${ws.id} and provider = ${provider} and status <> 'disabled'
       and not (provider_account_id = any(${ids}))`;
  return accountsSnapshot(ws);
}

/** Connected-or-not accounts of the active publisher, from the database. */
export async function accountsSnapshot(ws: WorkspaceContext): Promise<AccountRow[]> {
  const provider = ws.providers.publisher?.id ?? ws.config.providers.publisher;
  const rows = await ws.sql<{ id: string; provider_account_id: string; platform: Platform; handle: string; display_name: string | null; status: string }[]>`
    select id, provider_account_id, platform, handle, display_name, status from social_accounts
     where workspace_id = ${ws.id} and provider = ${provider} and status <> 'disabled'
     order by connected_at`;
  return rows.map((r) => ({
    id: r.id,
    providerAccountId: r.provider_account_id,
    platform: r.platform,
    handle: r.handle,
    ...(r.display_name ? { displayName: r.display_name } : {}),
    status: r.status === "connected" || r.status === "expired" ? r.status : "error",
  }));
}

/** Snapshot from the database, refreshed from the provider when empty or stale. */
export async function freshAccounts(ws: WorkspaceContext, opts: { maxAgeMinutes?: number } = {}): Promise<AccountRow[]> {
  const provider = ws.providers.publisher?.id ?? ws.config.providers.publisher;
  const [row] = await ws.sql<{ newest: Date | null }[]>`
    select max(updated_at) as newest from social_accounts where workspace_id = ${ws.id} and provider = ${provider}`;
  const maxAge = (opts.maxAgeMinutes ?? 60) * 60_000;
  if (!row?.newest || ws.now().getTime() - new Date(row.newest).getTime() > maxAge) {
    try {
      return await syncAccounts(ws);
    } catch (err) {
      ws.log.warn("publishing: couldn't refresh accounts, using the saved list", { error: (err as Error).message });
    }
  }
  return accountsSnapshot(ws);
}

export type ContentForPost = {
  id: string;
  title: string;
  status: string;
  ctaType: string | null;
  funnelStage: string | null;
  keyword: string | null;
  keywordId: string | null;
  leadMagnetUrl: string | null;
  postNumber: number | null;
  version: number;
  captions: Captions | null;
  media: MediaRef | null;
};

type ContentJoinRow = {
  id: string;
  title: string;
  status: string;
  cta_type: string | null;
  funnel_stage: string | null;
  keyword_id: string | null;
  keyword: string | null;
  lead_magnet_url: string | null;
  post_number: number | null;
  version: number | null;
  captions: unknown;
  media_uri: string | null;
  media_duration: string | number | null;
  media_kind: string | null;
};

function mediaFromUri(uri: string | null, kind: string | null, duration: string | number | null): MediaRef | null {
  if (!uri) return null;
  const isUrl = /^https?:\/\//.test(uri);
  const localPath = uri.replace(/^file:\/\//, "");
  const ext = localPath.split(".").pop()?.toLowerCase();
  const isImage = kind === "image" || kind === "thumbnail" || ["jpg", "jpeg", "png", "webp"].includes(ext ?? "");
  return {
    kind: isImage ? "image" : "video",
    ...(isUrl ? { url: uri } : { localPath }),
    ...(ext === "mp4" ? { mimeType: "video/mp4" } : ext === "mov" ? { mimeType: "video/quicktime" } : {}),
    ...(duration !== null && duration !== undefined ? { durationS: Number(duration) } : {}),
  };
}

function parseCaptions(raw: unknown): Captions | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = captionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const CONTENT_SELECT = (ws: WorkspaceContext) => ws.sql`
  select c.id, c.title, c.status, c.cta_type, c.funnel_stage, c.keyword_id, k.word::text as keyword,
         coalesce(lm.tracked_url, lm.url) as lead_magnet_url, c.post_number,
         s.version, s.captions,
         m.uri as media_uri, m.duration_s as media_duration, m.kind as media_kind
    from content c
    left join keywords k on k.id = c.keyword_id and k.workspace_id = c.workspace_id
    left join lead_magnets lm on lm.id = c.lead_magnet_id and lm.workspace_id = c.workspace_id
    left join lateral (
      select version, captions from scripts
       where content_id = c.id and workspace_id = c.workspace_id and status in ('approved', 'draft')
       order by (status = 'approved') desc, version desc limit 1
    ) s on true
    left join lateral (
      select uri, duration_s, kind from media_assets
       where content_id = c.id and workspace_id = c.workspace_id and kind = 'render'
       order by created_at desc limit 1
    ) m on true`;

function toContent(r: ContentJoinRow): ContentForPost {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    ctaType: r.cta_type,
    funnelStage: r.funnel_stage,
    keyword: r.keyword,
    keywordId: r.keyword_id,
    leadMagnetUrl: r.lead_magnet_url,
    postNumber: r.post_number,
    version: r.version ?? 1,
    captions: parseCaptions(r.captions),
    media: mediaFromUri(r.media_uri, r.media_kind, r.media_duration),
  };
}

export async function loadContent(ws: WorkspaceContext, contentId: string): Promise<ContentForPost | undefined> {
  const rows = await ws.sql<ContentJoinRow[]>`${CONTENT_SELECT(ws)} where c.workspace_id = ${ws.id} and c.id = ${contentId}`;
  return rows[0] ? toContent(rows[0]) : undefined;
}

/** Pieces with a finished render and captions, not yet planned on every platform, oldest deadline first. */
export async function readyContent(ws: WorkspaceContext, limit = 30): Promise<ContentForPost[]> {
  const rows = await ws.sql<ContentJoinRow[]>`
    ${CONTENT_SELECT(ws)}
     where c.workspace_id = ${ws.id} and c.status in ('review', 'scheduled') and m.uri is not null and s.captions is not null
     order by c.deadline_at nulls last, c.created_at
     limit ${limit}`;
  return rows.map(toContent);
}

/** Platforms a piece already has a live (not cancelled or failed) post on. */
export async function platformsWithPosts(ws: WorkspaceContext, contentIds: string[]): Promise<Map<string, Set<Platform>>> {
  const out = new Map<string, Set<Platform>>();
  if (contentIds.length === 0) return out;
  const rows = await ws.sql<{ content_id: string; platform: Platform }[]>`
    select distinct content_id, platform from posts
     where workspace_id = ${ws.id} and content_id = any(${contentIds}) and status not in ('cancelled', 'failed')`;
  for (const r of rows) {
    if (!out.has(r.content_id)) out.set(r.content_id, new Set());
    out.get(r.content_id)!.add(r.platform);
  }
  return out;
}

/** The post number used in `utm_content`, assigned once per piece from the workspace counter. */
export async function ensurePostNumber(ws: WorkspaceContext, contentId: string): Promise<number> {
  return ws.sql.begin(async (tx) => {
    const [row] = await tx<{ post_number: number | null }[]>`
      select post_number from content where workspace_id = ${ws.id} and id = ${contentId} for update`;
    if (!row) throw new Error("content not found");
    if (row.post_number) return row.post_number;
    const [{ n }] = (await tx`select aos_next_counter(${ws.id}, 'post_number') as n`) as unknown as [{ n: string }];
    await tx`update content set post_number = ${Number(n)}, updated_at = now() where workspace_id = ${ws.id} and id = ${contentId}`;
    return Number(n);
  });
}

/** Composed caption and per-platform options from the captions package. */
export function captionFor(captions: Captions | null, platform: Platform): { caption: string; options: PlatformOptions } | undefined {
  const c = captions?.[platform];
  if (!c) return undefined;
  const caption = composeCaption(platform, c as Parameters<typeof composeCaption>[1]);
  const options: PlatformOptions = {};
  if (platform === "youtube" && "title" in c) options.youtube = { title: c.title, privacy: "public", madeForKids: false, shorts: true };
  if (platform === "tiktok") options.tiktok = { privacy: "public", aiGenerated: false };
  return { caption, options };
}

export async function getPost(ws: WorkspaceContext, postId: string): Promise<PostRow | undefined> {
  const rows = await ws.sql<PostRow[]>`select * from posts where workspace_id = ${ws.id} and id = ${postId}`;
  return rows[0];
}

export async function getPostByKey(ws: WorkspaceContext, key: string): Promise<PostRow | undefined> {
  const rows = await ws.sql<PostRow[]>`select * from posts where workspace_id = ${ws.id} and idempotency_key = ${key}`;
  return rows[0];
}

export type NewPost = {
  contentId: string | null;
  socialAccountId: string | null;
  platform: Platform;
  provider: string;
  status: PostStatus;
  scheduledAt: string | null;
  caption: string;
  utmContent: string | null;
  shortLink: string | null;
  isTrial: boolean;
  variantOf: string | null;
  idempotencyKey: string;
  payload: PostPayload;
};

/** Inserts a post; the unique idempotency key makes this a no-op (created=false) for a post that already exists. */
export async function insertPost(ws: WorkspaceContext, p: NewPost): Promise<{ post: PostRow; created: boolean }> {
  const rows = await ws.sql<PostRow[]>`
    insert into posts (workspace_id, content_id, social_account_id, platform, provider, status, scheduled_at, caption,
                       utm_content, short_link, is_trial, variant_of, idempotency_key, payload)
    values (${ws.id}, ${p.contentId}, ${p.socialAccountId}, ${p.platform}, ${p.provider}, ${p.status}, ${p.scheduledAt},
            ${p.caption}, ${p.utmContent}, ${p.shortLink}, ${p.isTrial}, ${p.variantOf}, ${p.idempotencyKey}, ${ws.sql.json(p.payload as never)})
    on conflict (workspace_id, idempotency_key) do nothing
    returning *`;
  if (rows[0]) return { post: rows[0], created: true };
  const existing = await getPostByKey(ws, p.idempotencyKey);
  if (!existing) throw new Error("post vanished during insert");
  return { post: existing, created: false };
}

/** Re-arms a post that never reached the provider (failed before sending, cancelled, or a rejected draft). */
export async function rearmPost(ws: WorkspaceContext, postId: string, p: Pick<NewPost, "status" | "scheduledAt" | "caption" | "payload" | "socialAccountId" | "utmContent" | "shortLink">): Promise<PostRow> {
  const [row] = await ws.sql<PostRow[]>`
    update posts set status = ${p.status}, scheduled_at = ${p.scheduledAt}, caption = ${p.caption}, payload = ${ws.sql.json(p.payload as never)},
                     social_account_id = ${p.socialAccountId}, utm_content = ${p.utmContent}, short_link = ${p.shortLink},
                     error = null, updated_at = now()
     where workspace_id = ${ws.id} and id = ${postId} and provider_post_id is null
     returning *`;
  if (!row) throw new Error("this post already reached the provider and can't be re-armed");
  return row;
}

export async function updatePost(ws: WorkspaceContext, postId: string, patch: Partial<{
  status: PostStatus; provider_post_id: string | null; platform_post_id: string | null; url: string | null; published_at: Date | string | null;
  scheduled_at: Date | string | null; error: string | null; payload: PostPayload;
}>): Promise<PostRow | undefined> {
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  if (cols.length === 0) return getPost(ws, postId);
  const values: Record<string, unknown> = { ...patch };
  if (patch.payload) values.payload = ws.sql.json(patch.payload as never);
  const [row] = await ws.sql<PostRow[]>`
    update posts set ${ws.sql(values, ...cols)}, updated_at = now()
     where workspace_id = ${ws.id} and id = ${postId}
     returning *`;
  return row;
}

/** Moves content forward in its lifecycle, never backwards. */
export async function advanceContent(ws: WorkspaceContext, contentId: string | null, to: "scheduled" | "published", at?: Date): Promise<void> {
  if (!contentId) return;
  const before = to === "scheduled" ? ["idea", "scripted", "filming", "editing", "review"] : ["idea", "scripted", "filming", "editing", "review", "scheduled"];
  await ws.sql`
    update content set status = ${to}, updated_at = now(),
           published_at = ${to === "published" ? ws.sql`coalesce(published_at, ${at ?? ws.now()})` : ws.sql`published_at`}
     where workspace_id = ${ws.id} and id = ${contentId} and status = any(${before})`;
}

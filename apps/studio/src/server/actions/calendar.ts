"use server";

import { requireSession } from "@/server/auth";
import { refresh } from "next/cache";
import { recordAgentEvent } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, parse, platforms as platformsSchema } from "@/server/validate";

/**
 * Calendar mutations that aren't scheduling: cancel a post that hasn't gone out, and record a video you posted by
 * hand. Scheduling a ready video lives in actions/approvals.ts (scheduleReadyAction); moving a post in
 * actions/content.ts (reschedulePosts).
 */

export type CalendarResult = { ok: true; message: string } | { ok: false; error: string };

const ACTOR = "user:studio";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" };
const label = (p: string) => LABEL[p] ?? p;
const CANCELLABLE = ["draft", "queued", "scheduled", "assist"];

const postIdsInput = z.array(z.string().max(64)).max(500);
const postLiveInput = z.object({ postId: z.string().max(64), url: z.string().max(4_000).optional() });
const readyPostedInput = z.object({ releaseId: z.string().max(64), input: z.object({ platforms: platformsSchema.optional(), url: z.string().max(4_000).optional() }) });

function cleanUrl(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Cancels posts that haven't gone out. Posts the publisher already holds (sent to Zernio) can only be cancelled by
 * the Publisher with your publisher account, so those are left alone with a clear message.
 */
export async function cancelPostsAction(rawPostIds: string[]): Promise<CalendarResult> {
  await requireSession();
  const postIds = parse(postIdsInput, rawPostIds);
  if (!postIds) return { ok: false, error: BAD_REQUEST };
  const ws = workspace();
  const ids = [...new Set(postIds)].filter((id) => UUID.test(id));
  if (!ids.length) return { ok: false, error: "Nothing to cancel." };
  const rows = await ws.sql<{ id: string; status: string; platform: string; provider_post_id: string | null; title: string | null }[]>`
    select p.id, p.status, p.platform, p.provider_post_id, c.title
      from posts p left join content c on c.id = p.content_id
     where p.workspace_id = ${ws.id} and p.id = any(${ids}::uuid[])`;
  const local = rows.filter((r) => CANCELLABLE.includes(r.status) && !r.provider_post_id);
  const held = rows.filter((r) => CANCELLABLE.includes(r.status) && r.provider_post_id);
  if (!local.length) {
    if (held.length) return { ok: false, error: `Already sent to your publisher. Cancel it there (${held.map((r) => label(r.platform)).join(", ")}), or ask Chief of Staff to cancel it.` };
    return { ok: false, error: rows.some((r) => r.status === "published") ? "That post is already live. Delete it on the platform itself." : "These posts can't be cancelled." };
  }
  const localIds = local.map((r) => r.id);
  await ws.sql`
    update posts set status = 'cancelled', updated_at = now()
     where workspace_id = ${ws.id} and id = any(${localIds}::uuid[]) and status = any(${CANCELLABLE}) and provider_post_id is null`;
  await ws.sql`
    update approvals set status = 'expired', decided_at = now(), decision_note = 'post cancelled'
     where workspace_id = ${ws.id} and subject_type = 'posts' and subject_id = any(${localIds}::uuid[]) and status = 'pending'`;
  const title = local[0]?.title;
  const where = [...new Set(local.map((r) => label(r.platform)))].join(", ");
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "publisher",
    kind: "progress",
    message: `Cancelled ${title ? `“${title}”` : "a post"} on ${where}`,
    data: { by: ACTOR, postIds: localIds },
  });
  refresh();
  const note = held.length ? ` ${held.map((r) => label(r.platform)).join(", ")} is already with your publisher: cancel it there.` : "";
  return { ok: true, message: `Cancelled on ${where}.${note}` };
}

/** "Mark as posted" on a post you were reminded to post by hand (Instagram assist). */
export async function markPostLiveAction(rawPostId: string, rawUrl?: string): Promise<CalendarResult> {
  await requireSession();
  const args = parse(postLiveInput, { postId: rawPostId, url: rawUrl ?? undefined });
  if (!args) return { ok: false, error: BAD_REQUEST };
  const { postId, url } = args;
  if (!UUID.test(postId)) return { ok: false, error: "Unknown post." };
  const ws = workspace();
  const link = cleanUrl(url);
  if (url?.trim() && !link) return { ok: false, error: "That link doesn't look right. Paste the full post link, or leave it empty." };
  const [post] = await ws.sql<{ id: string; status: string; platform: string; content_id: string | null; title: string | null }[]>`
    select p.id, p.status, p.platform, p.content_id, c.title from posts p left join content c on c.id = p.content_id
     where p.workspace_id = ${ws.id} and p.id = ${postId}`;
  if (!post) return { ok: false, error: "Unknown post." };
  if (post.status === "published") return { ok: true, message: "Already marked as posted." };
  if (!["assist", "failed", "draft", "queued", "scheduled"].includes(post.status)) return { ok: false, error: "That post can't be marked as posted." };
  await ws.sql`
    update posts set status = 'published', published_at = now(), url = coalesce(${link}, url), error = null, updated_at = now()
     where workspace_id = ${ws.id} and id = ${post.id}`;
  await advanceContent(post.content_id);
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "publisher",
    kind: "progress",
    message: `“${post.title ?? "A post"}” is live on ${label(post.platform)} (posted by hand)`,
    data: { by: ACTOR, postId: post.id, url: link },
  });
  refresh();
  return { ok: true, message: `Marked as posted on ${label(post.platform)}.` };
}

/**
 * "Mark as posted" on a ready video you posted yourself: one published post per platform (provider "manual", so
 * results can be matched to it later), the content moves to published, and the video leaves Ready to post.
 */
export async function markReadyPostedAction(rawReleaseId: string, rawInput: { platforms: string[]; url?: string }): Promise<CalendarResult> {
  await requireSession();
  const args = parse(readyPostedInput, { releaseId: rawReleaseId, input: rawInput ?? {} });
  if (!args) return { ok: false, error: BAD_REQUEST };
  const { releaseId, input } = args;
  if (!UUID.test(releaseId)) return { ok: false, error: "Unknown video." };
  const ws = workspace();
  const platforms = [...new Set((input.platforms ?? []).filter((p) => p in LABEL))];
  if (!platforms.length) return { ok: false, error: "Pick where you posted it." };
  const link = cleanUrl(input.url);
  if (input.url?.trim() && !link) return { ok: false, error: "That link doesn't look right. Paste the full post link, or leave it empty." };
  const [r] = await ws.sql<{ id: string; status: string; content_id: string | null; title: string | null; outcomes: unknown[] | null; captions: Record<string, string> | null }[]>`
    select r.id, r.status, r.content_id, c.title, r.outcomes, r.captions
      from production_releases r left join content c on c.id = r.content_id
     where r.workspace_id = ${ws.id} and r.id = ${releaseId}`;
  if (!r) return { ok: false, error: "Unknown video." };
  if (r.status !== "ready" && r.status !== "failed") return { ok: false, error: "That video is already scheduled." };

  const now = new Date();
  const outcomes: { platform: string; outcome: string; postId: string; message: string; scheduledAt: string; mode: "assist" }[] = [];
  for (const platform of platforms) {
    const key = `manual:${r.id}:${platform}`;
    const title = r.title ?? "Video";
    const [post] = await ws.sql<{ id: string }[]>`
      insert into posts (workspace_id, content_id, platform, provider, status, scheduled_at, published_at, url, caption, idempotency_key, payload)
      values (${ws.id}, ${r.content_id}, ${platform}, 'manual', 'published', ${now}, ${now}, ${platforms.length === 1 ? link : null},
              ${r.captions?.[platform] ?? null}, ${key}, ${ws.sql.json({ mode: "assist", title, postedBy: ACTOR, releaseId: r.id } as never)})
      on conflict (workspace_id, idempotency_key) do update set status = 'published', published_at = excluded.published_at, updated_at = now()
      returning id`;
    outcomes.push({ platform, outcome: "published", postId: post!.id, message: "Posted by hand", scheduledAt: now.toISOString(), mode: "assist" });
  }
  await ws.sql`
    update production_releases set status = 'scheduled', outcomes = ${ws.sql.json(outcomes as never)}, updated_at = now()
     where workspace_id = ${ws.id} and id = ${r.id}`;
  await advanceContent(r.content_id);
  const where = platforms.map(label).join(", ");
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "publisher",
    kind: "progress",
    message: `“${r.title ?? "A video"}” is live on ${where} (posted by hand)`,
    data: { by: ACTOR, releaseId: r.id, postIds: outcomes.map((o) => o.postId), url: link },
  });
  refresh();
  return { ok: true, message: `Marked as posted on ${where}.` };
}

/** Content moves forward to published, never backwards (same rule as the publishing module). */
async function advanceContent(contentId: string | null): Promise<void> {
  if (!contentId) return;
  const ws = workspace();
  await ws.sql`
    update content set status = 'published', published_at = coalesce(published_at, now()), updated_at = now()
     where workspace_id = ${ws.id} and id = ${contentId} and status = any(${["idea", "scripted", "filming", "editing", "review", "scheduled"]})`;
}

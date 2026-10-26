import type { Sql, WorkspaceContext } from "@attentionos/core";
import { jsonb } from "@attentionos/core";
import { type HookRow } from "./db.ts";
import { classificationEnvelopeSchema, validateClassification } from "./classifier.ts";
import { scriptingSettings } from "./settings.ts";
import { HOOK_PATTERNS, preClassifyHook, UNCLASSIFIED } from "./taxonomy.ts";

/**
 * Hook banks:
 * - own: the user's openers that beat their own median by ≥ ownBankMultiplier (default 3×), from posts,
 *   post_metrics and the script that produced each post;
 * - competitor: spoken hooks of outlier posts from external_posts, capped (default 300) with exponential decay.
 */

export type HarvestResult = { own: { added: number; updated: number; median: number | null }; competitor: { added: number; active: number; retired: number } };

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export async function harvestOwnHooks(ws: WorkspaceContext): Promise<HarvestResult["own"]> {
  const settings = scriptingSettings(ws);
  const rows = await ws.sql<{ post_id: string; content_id: string | null; url: string | null; views: string | null; x_score: string | null; hook_text: string | null; pattern: string | null }[]>`
    with latest as (
      select distinct on (pm.post_id) pm.post_id, pm.views, pm.x_score
        from post_metrics pm where pm.workspace_id = ${ws.id}
       order by pm.post_id, pm.captured_at desc
    )
    select p.id as post_id, p.content_id, p.url, l.views, l.x_score,
           s.hook_text, coalesce(s.hook_source ->> 'pattern', c.hook_pattern) as pattern
      from posts p
      join latest l on l.post_id = p.id
      left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
      left join lateral (
        select hook_text, hook_source from scripts sc
         where sc.workspace_id = p.workspace_id and sc.content_id = p.content_id
         order by (sc.status = 'approved') desc, sc.version desc limit 1
      ) s on true
     where p.workspace_id = ${ws.id} and p.status = 'published' and p.is_trial = false`;
  const med = median(rows.map((r) => Number(r.views ?? NaN)));
  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const x = r.x_score !== null ? Number(r.x_score) : med ? Number(r.views ?? 0) / med : NaN;
    if (!Number.isFinite(x) || x < settings.ownBankMultiplier || !r.hook_text?.trim()) continue;
    const pattern = r.pattern && HOOK_PATTERNS.some((p) => p.id === r.pattern) ? r.pattern : preClassifyHook(r.hook_text)?.pattern ?? UNCLASSIFIED;
    const res = await ws.sql<{ inserted: boolean }[]>`
      insert into hooks (workspace_id, text, pattern, origin, source_ref, score, wins)
      values (${ws.id}, ${r.hook_text.trim()}, ${pattern}, 'own', ${jsonb(ws.sql, { post_id: r.post_id, content_id: r.content_id, url: r.url })}, ${x}, 1)
      on conflict (workspace_id, (source_ref ->> 'post_id')) where origin = 'own'
      do update set score = excluded.score
      returning (xmax = 0) as inserted`;
    if (res[0]?.inserted) added++;
    else updated++;
  }
  return { added, updated, median: med };
}

export async function harvestCompetitorHooks(ws: WorkspaceContext): Promise<HarvestResult["competitor"]> {
  const settings = scriptingSettings(ws);
  const now = ws.now();
  const fresh = await ws.sql<{ id: string; spoken_hook: string; url: string; author_handle: string; x_score: string | null }[]>`
    select ep.id, ep.spoken_hook, ep.url, ep.author_handle, ep.x_score from external_posts ep
     where ep.workspace_id = ${ws.id} and ep.is_outlier and not ep.is_meme
       and ep.spoken_hook is not null and length(trim(ep.spoken_hook)) > 0
       and not exists (
         select 1 from hooks h where h.workspace_id = ep.workspace_id and h.origin = 'competitor'
            and h.source_ref ->> 'external_post_id' = ep.id::text)`;
  let added = 0;
  for (const r of fresh) {
    // Untrusted text: stored for the dashboard, never shown to tool-using agents (they see the abstract).
    const text = r.spoken_hook.replace(/\s+/g, " ").trim().slice(0, 500);
    const pattern = preClassifyHook(text)?.pattern ?? UNCLASSIFIED;
    const res = await ws.sql`
      insert into hooks (workspace_id, text, pattern, origin, source_ref, score)
      values (${ws.id}, ${text}, ${pattern}, 'competitor', ${jsonb(ws.sql, { external_post_id: r.id, url: r.url, author: r.author_handle })}, ${r.x_score === null ? null : Number(r.x_score)})
      on conflict (workspace_id, (source_ref ->> 'external_post_id')) where origin = 'competitor' do nothing`;
    added += res.count;
  }
  const counts = await applyCompetitorDecay(ws.sql, ws.id, { now, halfLifeDays: settings.competitorHalfLifeDays, cap: settings.competitorBankCap });
  return { added, ...counts };
}

/** Re-scores competitor hooks with exponential decay and retires everything past the cap. Never re-activates. */
export async function applyCompetitorDecay(sql: Sql, workspaceId: string, opts: { now: Date; halfLifeDays: number; cap: number }): Promise<{ active: number; retired: number }> {
  await sql`
    with scored as (
      select h.id,
             coalesce(ep.x_score, 1)::float8
               * power(0.5, greatest(0, extract(epoch from (${opts.now}::timestamptz - coalesce(ep.published_at, h.created_at))) / 86400.0) / ${opts.halfLifeDays}::float8) as s
        from hooks h
        left join external_posts ep on ep.workspace_id = h.workspace_id and ep.id::text = h.source_ref ->> 'external_post_id'
       where h.workspace_id = ${workspaceId} and h.origin = 'competitor'
    ), ranked as (
      select s.id, s.s, row_number() over (order by s.s desc, s.id) as rn
        from scored s join hooks h on h.id = s.id where h.status = 'active'
    )
    update hooks h set score = round(r.s::numeric, 4), status = case when r.rn > ${opts.cap} then 'retired' else h.status end
      from ranked r where h.id = r.id`;
  const rows = await sql<{ status: string; n: string }[]>`
    select status, count(*) as n from hooks where workspace_id = ${workspaceId} and origin = 'competitor' group by status`;
  const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { active: n("active"), retired: n("retired") };
}

/** Hooks waiting for the LLM classifier (pre-classifier found nothing, or no abstract yet). */
export async function hooksToClassify(ws: WorkspaceContext, limit = 40): Promise<Pick<HookRow, "id" | "text" | "pattern">[]> {
  return ws.sql<Pick<HookRow, "id" | "text" | "pattern">[]>`
    select id, text, pattern from hooks
     where workspace_id = ${ws.id} and status = 'active' and origin = 'competitor' and abstract is null
     order by score desc nulls last limit ${limit}`;
}

/**
 * Writes validated classifier output. Items that failed validation keep the regex pattern (or stay
 * unclassified) and get the taxonomy template as their structure.
 */
export async function applyClassifications(ws: WorkspaceContext, output: unknown, sent: readonly { id: string; text: string }[]) {
  const { accepted, report } = validateClassification(output, sent);
  for (const a of accepted) {
    await ws.sql`update hooks set pattern = ${a.pattern}, abstract = ${a.abstract} where workspace_id = ${ws.id} and id = ${a.id}`;
  }
  return { applied: accepted.length, rejected: report.errors.length, report };
}

export { classificationEnvelopeSchema };

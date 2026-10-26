import type { Sql, WorkspaceContext } from "@attentionos/core";

/** Row shapes and small queries. Every query filters by workspace_id. */

export type ContentRow = {
  id: string;
  title: string;
  status: string;
  kind: string;
  lane: string | null;
  pillar: string | null;
  funnel_stage: string | null;
  angle: string | null;
  story_structure: string | null;
  template: string | null;
  hook_id: string | null;
  hook_pattern: string | null;
  cta_type: string | null;
  keyword_id: string | null;
  lead_magnet_id: string | null;
  post_number: number | null;
  source_refs: { type?: string; id?: string; url?: string }[] | null;
  brief: Record<string, unknown> | null;
  film_by: Date | null;
  deadline_at: Date | null;
  created_at?: Date;
};

export type ScriptRow = {
  id: string;
  content_id: string;
  version: number;
  body: string;
  beats: { role: string; text: string }[] | null;
  hook_text: string | null;
  hook_source: Record<string, unknown> | null;
  claim_ledger: { id?: string; claim: string; verdict: string; source?: string | null; note?: string }[] | null;
  validator_report: { ok?: boolean; errors?: unknown[]; warnings?: unknown[] } | null;
  captions: Record<string, unknown> | null;
  status: string;
  created_by: string;
  created_at: Date;
};

export type HookRow = {
  id: string;
  text: string;
  pattern: string;
  origin: "own" | "competitor" | "manual";
  source_ref: Record<string, unknown> | null;
  uses: number;
  wins: number;
  score: string | number | null;
  status: string;
  abstract: string | null;
  last_used_at: Date | null;
  created_at: Date;
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getContent(ws: WorkspaceContext, id: string): Promise<ContentRow | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await ws.sql<ContentRow[]>`
    select id, title, status, kind, lane, pillar, funnel_stage, angle, story_structure, template, hook_id, hook_pattern,
           cta_type, keyword_id, lead_magnet_id, post_number, source_refs, brief, film_by, deadline_at, created_at
      from content where workspace_id = ${ws.id} and id = ${id}`;
  return rows[0] ?? null;
}

export async function getContentKeyword(ws: WorkspaceContext, contentId: string): Promise<{ id: string; word: string; status: string } | null> {
  const rows = await ws.sql<{ id: string; word: string; status: string }[]>`
    select k.id, k.word::text as word, k.status from keywords k
     where k.workspace_id = ${ws.id} and k.content_id = ${contentId}
     order by (k.status = 'active') desc, k.created_at desc limit 1`;
  return rows[0] ?? null;
}

/** Every keyword in the ledger except the ones reserved for this content. */
export async function ledgerWords(ws: WorkspaceContext, excludeContentId?: string | null, sql: Sql = ws.sql): Promise<string[]> {
  const rows = await sql<{ word: string }[]>`
    select word::text as word from keywords
     where workspace_id = ${ws.id} and (${excludeContentId ?? null}::uuid is null or content_id is distinct from ${excludeContentId ?? null}::uuid)`;
  return rows.map((r) => r.word);
}

export async function latestScript(ws: WorkspaceContext, contentId: string): Promise<ScriptRow | null> {
  const rows = await ws.sql<ScriptRow[]>`
    select * from scripts where workspace_id = ${ws.id} and content_id = ${contentId} order by version desc limit 1`;
  return rows[0] ?? null;
}

/** Latest version per content, newest first. */
export async function recentScripts(ws: WorkspaceContext, opts: { limit: number; excludeContentId?: string | null }): Promise<(ScriptRow & { title: string; keyword: string | null })[]> {
  return ws.sql<(ScriptRow & { title: string; keyword: string | null })[]>`
    select s.*, c.title, (select k.word::text from keywords k where k.workspace_id = s.workspace_id and k.id = c.keyword_id) as keyword
      from (
        select distinct on (content_id) * from scripts
         where workspace_id = ${ws.id} and status <> 'rejected'
           and (${opts.excludeContentId ?? null}::uuid is null or content_id <> ${opts.excludeContentId ?? null}::uuid)
         order by content_id, version desc
      ) s
      join content c on c.id = s.content_id and c.workspace_id = s.workspace_id
     order by s.created_at desc
     limit ${opts.limit}`;
}

/** How many of the newest versions of this content failed validation in a row. */
export async function consecutiveFailures(ws: WorkspaceContext, contentId: string): Promise<number> {
  const rows = await ws.sql<{ ok: boolean | null }[]>`
    select (validator_report ->> 'ok')::boolean as ok from scripts
     where workspace_id = ${ws.id} and content_id = ${contentId} order by version desc limit 20`;
  let n = 0;
  for (const r of rows) {
    if (r.ok === false) n++;
    else break;
  }
  return n;
}

export async function nextRef(sql: Sql, workspaceId: string, prefix: string): Promise<string> {
  const rows = await sql<{ n: string }[]>`select aos_next_counter(${workspaceId}, ${prefix}) as n`;
  return `${prefix}-${rows[0]!.n}`;
}

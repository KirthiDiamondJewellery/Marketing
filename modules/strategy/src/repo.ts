import { jsonb, nextRef, type FunnelStage, type WorkspaceContext } from "@attentionos/core";
import { iso, listOutliers, listTrends, num, periodStart } from "@attentionos/module-research";
import { localDay, zonedParts } from "@attentionos/scoring";
import type { OutlierCandidate, ProofCandidate, RecentPiece, SlateItem, TrendCandidate } from "./planner.ts";
import { sameVideoKeys, type RemixPoolItem } from "./remix.ts";

const D = 86_400_000;

/** Monday 00:00 of the current week in the workspace time zone. */
export function weekStart(now: Date, timeZone: string): Date {
  const dayStart = periodStart(now, timeZone, "day");
  const daysSinceMonday = (zonedParts(now, timeZone).weekday + 6) % 7;
  return periodStart(new Date(dayStart.getTime() - daysSinceMonday * D + 12 * 3_600_000), timeZone, "day");
}

export async function laneCountsSince(ws: WorkspaceContext, since: Date): Promise<Record<string, number>> {
  const rows = await ws.sql`
    select lane, count(*)::int as n from content
     where workspace_id = ${ws.id} and created_at >= ${since} and status <> 'archived' and lane is not null
     group by lane`;
  return Object.fromEntries(rows.map((r) => [r.lane as string, Number(r.n)]));
}

type SourceRefRow = { type?: string; id?: string };

export async function recentPieces(ws: WorkspaceContext, limit = 60): Promise<RecentPiece[]> {
  const rows = await ws.sql`
    select c.title, c.lane, c.funnel_stage, c.angle, c.template, c.story_structure, c.created_at, c.source_refs, c.status,
           c.brief -> 'remixOf' ->> 'externalPostId' as remix_of,
           exists (select 1 from scripts sc where sc.workspace_id = c.workspace_id and sc.content_id = c.id and sc.status = 'approved') as approved
      from content c
     where c.workspace_id = ${ws.id} and c.status <> 'archived'
     order by c.created_at desc limit ${limit}`;
  return rows.map((r) => ({
    title: r.title as string,
    lane: (r.lane as string | null) ?? null,
    funnelStage: (r.funnel_stage as FunnelStage | null) ?? null,
    angle: (r.angle as string | null) ?? null,
    template: (r.template as string | null) ?? null,
    storyStructure: (r.story_structure as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    sourceIds: ((r.source_refs as SourceRefRow[] | null) ?? []).map((s) => s.id).filter((x): x is string => !!x),
    // Proven posts this piece has taken: the one it remixes, or everything it cited once it was filmed or approved.
    // A draft that only cited a post (before remixOf existed) doesn't block a proper remix of it.
    remixSourceIds: (r.status !== "idea" && r.status !== "scripted") || r.approved
      ? ((r.source_refs as SourceRefRow[] | null) ?? []).filter((s) => s.type === "external_post").map((s) => s.id).filter((x): x is string => !!x)
      : r.remix_of ? [r.remix_of as string] : [],
  }));
}

/** Proof items with their last use: the later of `lastUsedAt` in the YAML and the newest content that cited them. */
export async function proofCandidates(ws: WorkspaceContext): Promise<ProofCandidate[]> {
  const rows = await ws.sql`
    select ref->>'id' as id, max(c.created_at) as last
      from content c, jsonb_array_elements(c.source_refs) ref
     where c.workspace_id = ${ws.id} and ref->>'type' = 'proof' and c.status <> 'archived'
     group by ref->>'id'`;
  const used = new Map(rows.map((r) => [r.id as string, iso(r.last)]));
  return ws.brand().proofInventory.items.map((p) => {
    const db = used.get(p.id) ?? null;
    const yaml = p.lastUsedAt ? new Date(p.lastUsedAt).toISOString() : null;
    const lastUsedAt = [db, yaml].filter((x): x is string => !!x).sort().pop() ?? null;
    return { id: p.id, kind: p.kind, title: p.title, summary: p.summary, numbers: p.numbers, clientConsent: p.clientConsent, lastUsedAt };
  });
}

export async function trendCandidates(ws: WorkspaceContext): Promise<TrendCandidate[]> {
  const rows = await listTrends(ws, { status: ["kit"], sinceHours: 48, limit: 20 });
  return rows.map((t) => ({
    id: t.id,
    url: t.url,
    heat: t.heat ?? 0,
    header: typeof t.story?.header === "string" ? t.story.header : null,
    filmBy: t.filmBy,
    hasKit: true,
  }));
}

/**
 * Whether a proven post is already taken: a live piece remixes it (brief.remixOf), or a piece that cites it went on
 * to be filmed or approved. A piece that only cited it (an older "use its structure" idea, written before remixOf
 * existed) and never got past a draft doesn't block a proper remix of it. Expects `ep` = external_posts.
 */
export const usedAsRemixSql = (ws: WorkspaceContext) => ws.sql`
  exists (select 1 from content c where c.workspace_id = ep.workspace_id and c.status <> 'archived'
            and exists (select 1 from jsonb_array_elements(coalesce(c.source_refs, '[]'::jsonb)) s
                         where s ->> 'type' = 'external_post' and s ->> 'id' = ep.id::text)
            and (c.brief -> 'remixOf' ->> 'externalPostId' = ep.id::text
                 or c.status not in ('idea', 'scripted')
                 or exists (select 1 from scripts sc where sc.workspace_id = c.workspace_id and sc.content_id = c.id and sc.status = 'approved')))`;

/**
 * Proven posts to remake: competitor outliers and the owner's own posts (tier own, times their median views), with
 * whether each has a checked blueprint and whether it was already remade. `matchText` (caption, spoken hook,
 * blueprint) is for niche matching in code only.
 */
export async function remixPool(ws: WorkspaceContext, opts: { maxAgeDays: number; ownMaxAgeDays: number; bigViews?: number; provenMaxAgeDays?: number }): Promise<RemixPoolItem[]> {
  const now = ws.now().getTime();
  const since = new Date(now - opts.maxAgeDays * 86_400_000);
  const ownSince = new Date(now - opts.ownMaxAgeDays * 86_400_000);
  // Proven beyond doubt: a competitor's pinned post or one past `bigViews`. The scan leaves pinned posts out of its
  // outlier scoring (they'd skew the baseline), but a pinned reel is usually that creator's best: worth remaking.
  const provenSince = new Date(now - (opts.provenMaxAgeDays ?? 365) * 86_400_000);
  const bigViews = opts.bigViews ?? 500_000;
  const rows = await ws.sql`
    with own_median as (
      select percentile_cont(0.5) within group (order by p.views)::float8 as med
        from external_posts p join tracked_creators c on c.id = p.tracked_creator_id and c.workspace_id = p.workspace_id
       where p.workspace_id = ${ws.id} and c.tier = 'own' and p.views > 0
    )
    select ep.id, ep.url, ep.platform, ep.author_handle, ep.views, ep.x_score, ep.published_at, ep.caption, ep.spoken_hook, ep.tags, ep.duration_s,
           ep.transcript is not null as has_transcript, tc.tier,
           case when tc.tier = 'own' then ep.views / nullif((select med from own_median), 0)
                else coalesce(ep.x_score, ep.views / nullif(coalesce((tc.baseline ->> 'views')::float8, cm.med), 0)) end as x,
           bp.blueprint,
           (coalesce(tc.tier, '') <> 'own' and (ep.is_pinned or ep.views >= ${bigViews})) as proven,
           ${usedAsRemixSql(ws)} as used
      from external_posts ep
      left join tracked_creators tc on tc.id = ep.tracked_creator_id and tc.workspace_id = ep.workspace_id
      left join lateral (
        select t.fingerprint -> 'facets' -> 'blueprint' as blueprint from teardowns t
         where t.workspace_id = ep.workspace_id and t.external_post_id = ep.id and t.fingerprint -> 'facets' ? 'blueprint'
         order by t.created_at desc limit 1
      ) bp on true
      left join lateral (
        select percentile_cont(0.5) within group (order by o.views)::float8 as med from external_posts o
         where o.workspace_id = ep.workspace_id and o.tracked_creator_id = ep.tracked_creator_id and not o.is_pinned and o.views > 0
      ) cm on true
     where ep.workspace_id = ${ws.id} and not ep.is_meme
       and ((coalesce(tc.tier, '') <> 'own' and ep.is_outlier and ep.published_at >= ${since})
         or (coalesce(tc.tier, '') <> 'own' and (ep.is_pinned or ep.views >= ${bigViews}) and (ep.published_at is null or ep.published_at >= ${provenSince}))
         or (tc.tier = 'own' and ep.views > 0 and (ep.published_at is null or ep.published_at >= ${ownSince})))
     order by x desc nulls last
     limit 200`;
  return rows.flatMap((r): RemixPoolItem[] => {
    // A proven post (pinned or past bigViews) qualifies without a times-normal (0 = unknown).
    const x = num(r.x) ?? (r.proven ? 0 : null);
    if (x === null) return [];
    const bp = (r.blueprint ?? null) as { topic?: string; hookLine?: string; hookPattern?: string; format?: string; beats?: { says?: string }[] } | null;
    const tags = (r.tags ?? {}) as Record<string, unknown>;
    return [{
      id: r.id as string,
      url: r.url as string,
      creator: `@${String(r.author_handle).replace(/^@+/, "")}`,
      platform: r.platform as string,
      x: Math.round(x * 100) / 100,
      views: num(r.views),
      publishedAt: iso(r.published_at),
      own: r.tier === "own",
      tier: (r.tier as string | null) ?? null,
      hasBlueprint: Boolean(bp),
      hasTranscript: Boolean(r.has_transcript),
      topic: typeof bp?.topic === "string" ? bp.topic : null,
      hookPattern: bp?.hookPattern ?? (typeof tags.hook_pattern === "string" ? tags.hook_pattern : null),
      format: bp?.format ?? (typeof tags.format === "string" ? tags.format : null),
      matchText: [r.caption, r.spoken_hook, bp?.topic, bp?.hookLine, ...(bp?.beats ?? []).map((b) => b.says)].filter(Boolean).join(" "),
      used: Boolean(r.used),
      proven: Boolean(r.proven),
      sameVideo: sameVideoKeys(String(r.author_handle), (r.spoken_hook as string | null) ?? bp?.hookLine ?? null, num(r.duration_s)),
    }];
  });
}

export async function outlierCandidates(ws: WorkspaceContext): Promise<OutlierCandidate[]> {
  const rows = await listOutliers(ws, { sinceDays: 14, limit: 30 });
  return rows.filter((o) => o.xScore !== null).map((o) => ({
    id: o.id,
    url: o.url,
    creator: `@${o.authorHandle.replace(/^@+/, "")}`,
    platform: o.platform,
    x: o.xScore!,
    hookPattern: typeof o.tags?.hook_pattern === "string" ? o.tags.hook_pattern : null,
    format: typeof o.tags?.format === "string" ? o.tags.format : null,
  }));
}

export type BriefRow = {
  id: string;
  title: string;
  status: string;
  /** content.kind: reel, story, longform (filmed) or text, carousel (not filmed). */
  kind: string;
  lane: string | null;
  funnelStage: string | null;
  angle: string | null;
  storyStructure: string | null;
  template: string | null;
  ctaType: string | null;
  sourceRefs: unknown[];
  brief: Record<string, unknown>;
  filmBy: string | null;
  createdAt: string | null;
};

const toBriefRow = (r: Record<string, unknown>): BriefRow => ({
  id: r.id as string,
  title: r.title as string,
  status: r.status as string,
  kind: (r.kind as string | null) ?? "reel",
  lane: (r.lane as string | null) ?? null,
  funnelStage: (r.funnel_stage as string | null) ?? null,
  angle: (r.angle as string | null) ?? null,
  storyStructure: (r.story_structure as string | null) ?? null,
  template: (r.template as string | null) ?? null,
  ctaType: (r.cta_type as string | null) ?? null,
  sourceRefs: (r.source_refs as unknown[]) ?? [],
  brief: (r.brief as Record<string, unknown>) ?? {},
  filmBy: iso(r.film_by),
  createdAt: iso(r.created_at),
});

export async function briefFor(ws: WorkspaceContext, date: string, mode: "daily" | "batch"): Promise<BriefRow[]> {
  const rows = await ws.sql`
    select * from content
     where workspace_id = ${ws.id} and brief->>'briefDate' = ${date} and brief->>'mode' = ${mode}
     order by (brief->>'slot')::int`;
  return rows.map(toBriefRow);
}

export async function getContent(ws: WorkspaceContext, id: string): Promise<BriefRow | null> {
  const [r] = await ws.sql`select * from content where workspace_id = ${ws.id} and id = ${id}`;
  return r ? toBriefRow(r) : null;
}

export async function listIdeas(ws: WorkspaceContext, f: { lane?: string; status?: string[]; limit?: number } = {}): Promise<BriefRow[]> {
  const rows = await ws.sql`
    select * from content where workspace_id = ${ws.id}
       and status = any(${f.status ?? ["idea"]}::text[])
       ${f.lane ? ws.sql`and lane = ${f.lane}` : ws.sql``}
     order by film_by nulls last, created_at desc limit ${f.limit ?? 20}`;
  return rows.map(toBriefRow);
}

export type ShootDirections = Record<string, { useFor: string; shootDirections: string }>;

/** Writes the slate as `content` rows (status idea) in one transaction. */
export async function insertSlate(ws: WorkspaceContext, items: SlateItem[], meta: { date: string; mode: "daily" | "batch"; formats: ShootDirections }): Promise<BriefRow[]> {
  const out: BriefRow[] = [];
  await ws.sql.begin(async (tx) => {
    for (const it of items) {
      const brief = {
        briefDate: meta.date,
        mode: meta.mode,
        slot: it.slot,
        kind: it.kind,
        why: it.why,
        laneName: it.laneName,
        header: null,
        shootDirections: meta.formats[it.template]?.shootDirections ?? null,
        ...(it.proof ? { proof: it.proof } : {}),
        ...(it.remixOf ? { remixOf: it.remixOf } : {}),
      };
      const [r] = await tx`
        insert into content (workspace_id, title, status, kind, lane, pillar, funnel_stage, angle, story_structure, template, cta_type,
                             source_refs, brief, film_by, deadline_at, created_by, created_at, updated_at)
        values (${ws.id}, ${it.title}, 'idea', 'reel', ${it.lane}, ${it.laneName}, ${it.funnelStage}, ${it.angle}, ${it.storyStructure},
                ${it.template}, ${it.ctaType}, ${jsonb(tx, it.sourceRefs)}, ${jsonb(tx, brief)}, ${it.filmBy}, ${it.filmBy},
                'agent:strategist', ${ws.now()}, ${ws.now()})
        returning *`;
      out.push(toBriefRow(r!));
    }
  });
  return out;
}

/** One approval row summarising the brief, so every surface shows it in the approvals queue. */
export async function createBriefApproval(ws: WorkspaceContext, summary: string, preview: unknown, runId?: string | null): Promise<string> {
  const ref = await nextRef(ws.sql, ws.id, "ap");
  await ws.sql`
    insert into approvals (workspace_id, ref, kind, subject_type, subject_id, agent, status, summary, preview, run_id)
    values (${ws.id}, ${ref}, 'other', 'daily_brief', null, 'strategist', 'pending', ${summary}, ${jsonb(ws.sql, preview)}, ${runId ?? null})`;
  return ref;
}

export const todayLocal = (ws: WorkspaceContext) => localDay(ws.now(), ws.config.workspace.timezone);

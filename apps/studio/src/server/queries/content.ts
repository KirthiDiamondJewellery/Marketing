import "server-only";
import { workspace } from "@/server/workspace";
import { mediaOnDisk, toMetrics, type CalendarPost } from "./calendar";

export const LIFECYCLE = ["idea", "scripted", "filming", "editing", "review", "scheduled", "published", "measured"] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------------------
// Pipeline board
// ---------------------------------------------------------------------------------------------------------------

export type PipelineItem = {
  id: string;
  title: string;
  status: string;
  kind: string;
  lane: string | null;
  funnel: string | null;
  hookPattern: string | null;
  filmBy: string | null;
  updatedAt: string;
  createdBy: string;
  thumbId: string | null;
  nextPostAt: string | null;
  platforms: string[];
  bestX: number | null;
  views: number | null;
  editRef: string | null;
  editStatus: string | null;
  scriptVersion: number | null;
  needsYou: number;
};

export async function pipeline(): Promise<PipelineItem[]> {
  const ws = workspace();
  const rows = await ws.sql<
    {
      id: string;
      title: string;
      status: string;
      kind: string;
      lane: string | null;
      funnel_stage: string | null;
      hook_pattern: string | null;
      film_by: Date | null;
      updated_at: Date;
      created_by: string;
      thumb_id: string | null;
      next_post_at: Date | null;
      platforms: string[] | null;
      best_x: string | null;
      views: string | null;
      edit_ref: string | null;
      edit_status: string | null;
      script_version: number | null;
      needs_you: number;
    }[]
  >`
    select c.id, c.title, c.status, c.kind, c.lane, c.funnel_stage, c.hook_pattern, c.film_by, c.updated_at, c.created_by,
           (select a.id || '|' || a.uri from media_assets a where a.workspace_id = c.workspace_id and a.content_id = c.id and a.kind in ('thumbnail', 'image')
             order by a.created_at desc limit 1) as thumb_id,
           (select min(p.scheduled_at) from posts p where p.workspace_id = c.workspace_id and p.content_id = c.id
             and p.status in ('draft', 'queued', 'scheduled', 'assist') and p.scheduled_at is not null) as next_post_at,
           (select array_agg(distinct p.platform) from posts p where p.workspace_id = c.workspace_id and p.content_id = c.id and p.status <> 'cancelled') as platforms,
           (select max(m.x_score)::text from post_metrics m join posts p on p.id = m.post_id where p.workspace_id = c.workspace_id and p.content_id = c.id) as best_x,
           (select sum(lm.views)::text from posts p
              join lateral (select views from post_metrics m where m.post_id = p.id order by m.captured_at desc limit 1) lm on true
             where p.workspace_id = c.workspace_id and p.content_id = c.id) as views,
           e.ref as edit_ref, e.status as edit_status,
           (select max(s.version) from scripts s where s.workspace_id = c.workspace_id and s.content_id = c.id) as script_version,
           (select count(*)::int from approvals ap where ap.workspace_id = c.workspace_id and ap.status = 'pending' and (
              ap.subject_id = c.id
              or ap.subject_id in (select s.id from scripts s where s.content_id = c.id)
              or ap.subject_id in (select p.id from posts p where p.content_id = c.id)
              or ap.subject_id in (select j.id from edit_jobs j where j.content_id = c.id))) as needs_you
      from content c
      left join lateral (select ref, status from edit_jobs j where j.workspace_id = c.workspace_id and j.content_id = c.id order by j.created_at desc limit 1) e on true
     where c.workspace_id = ${ws.id} and c.status <> 'archived'
     order by c.updated_at desc`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    kind: r.kind,
    lane: r.lane,
    funnel: r.funnel_stage,
    hookPattern: r.hook_pattern,
    filmBy: r.film_by?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
    createdBy: r.created_by,
    thumbId: r.thumb_id && mediaOnDisk(r.thumb_id.slice(37)) ? r.thumb_id.slice(0, 36) : null,
    nextPostAt: r.next_post_at?.toISOString() ?? null,
    platforms: r.platforms ?? [],
    bestX: r.best_x === null ? null : Number(r.best_x),
    views: r.views === null ? null : Number(r.views),
    editRef: r.edit_ref,
    editStatus: r.edit_status,
    scriptVersion: r.script_version,
    needsYou: r.needs_you,
  }));
}

export async function contentOptions(): Promise<{ id: string; title: string; status: string }[]> {
  const ws = workspace();
  return ws.sql<{ id: string; title: string; status: string }[]>`
    select id, title, status from content where workspace_id = ${ws.id} and status in ('idea', 'scripted', 'filming', 'editing')
     order by case status when 'filming' then 0 when 'scripted' then 1 when 'editing' then 2 else 3 end, updated_at desc`;
}

export async function laneOptions(): Promise<string[]> {
  const ws = workspace();
  const rows = await ws.sql<{ lane: string }[]>`
    select lane from content where workspace_id = ${ws.id} and lane is not null group by lane order by count(*) desc`;
  return rows.map((r) => r.lane);
}

// ---------------------------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------------------------

export type Beat = { role: string; text: string };
export type Claim = { claim: string; verdict: "PASS" | "FIX" | "CUT" | string; source?: string | null; note?: string | null };
export type ValidatorCheck = { rule: string; ok: boolean; detail?: string | null };
export type CaptionSet = Record<string, Record<string, unknown>>;

export type ScriptVersion = {
  id: string;
  version: number;
  status: string;
  body: string;
  beats: Beat[];
  hookText: string | null;
  hookSource: { hook_id?: string | null; pattern?: string | null; origin?: string | null; ref?: string | null } | null;
  claims: Claim[];
  validator: { ok: boolean; checks: ValidatorCheck[] } | null;
  captions: CaptionSet | null;
  createdBy: string;
  createdAt: string;
};

export type QcCheckView = { id: string; label: string; status: "pass" | "warn" | "fail" | "skip"; detail: string; fix?: string };

export type EditJobView = {
  id: string;
  ref: string;
  status: string;
  version: number;
  format: string | null;
  engine: string;
  createdAt: string;
  updatedAt: string;
  costUsd: number;
  renders: { assetId: string; version: number; durationS: number | null; createdAt: string; uri: string }[];
  outputAssetId: string | null;
  sourceAsset: { id: string; uri: string; durationS: number | null } | null;
  qc: { passed: boolean; summary: string; checks: QcCheckView[] } | null;
  preflight: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  cutSummary: { keep: number; dropped: number; outputS: number | null } | null;
  notes: { at: string; by: string; version: number; text: string; channel: string | null }[];
  pendingApproval: { ref: string; summary: string } | null;
};

export type SourceRef = { type: string; label: string; detail?: string | null; url?: string | null; href?: string | null };

export type ContentDetail = {
  id: string;
  title: string;
  status: string;
  kind: string;
  lane: string | null;
  pillar: string | null;
  funnel: string | null;
  angle: string | null;
  storyStructure: string | null;
  template: string | null;
  hookPattern: string | null;
  ctaType: string | null;
  postNumber: number | null;
  filmBy: string | null;
  deadlineAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  brief: { header?: string; why?: string; shoot_directions?: string[]; deadline_label?: string } | null;
  hook: { text: string; pattern: string; origin: string; uses: number; wins: number; score: number | null; sourceLabel: string | null } | null;
  keyword: { word: string; status: string } | null;
  leadMagnet: { title: string; url: string | null; kind: string } | null;
  sources: SourceRef[];
  thumbId: string | null;
  scripts: ScriptVersion[];
  edits: EditJobView[];
  posts: CalendarPost[];
  pending: { ref: string; kind: string; summary: string; agent: string }[];
};

type Json = Record<string, unknown>;

function qcView(raw: unknown): EditJobView["qc"] {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Json;
  if (Array.isArray(q.checks)) {
    return {
      passed: Boolean(q.passed),
      summary: String(q.summary ?? ""),
      checks: (q.checks as Json[]).map((c) => ({
        id: String(c.id ?? c.label),
        label: String(c.label ?? c.id),
        status: (["pass", "warn", "fail", "skip"].includes(String(c.status)) ? c.status : "pass") as QcCheckView["status"],
        detail: String(c.detail ?? ""),
        ...(c.fix ? { fix: String(c.fix) } : {}),
      })),
    };
  }
  // Compact form (older reports): {ok, loudness_lufs, true_peak_db, max_pause_s, black_frames, freezes, caption_safe_zone, issues}.
  const checks: QcCheckView[] = [];
  const num = (k: string) => (typeof q[k] === "number" ? (q[k] as number) : null);
  const lufs = num("loudness_lufs");
  if (lufs !== null) {
    const ok = Math.abs(lufs + 14) <= 1;
    checks.push({ id: "loudness", label: "Loudness", status: ok ? "pass" : "fail", detail: `${lufs.toFixed(1)} LUFS (target −14)`, ...(ok ? {} : { fix: "Re-run the finish step to normalise to −14 LUFS." }) });
  }
  const tp = num("true_peak_db");
  if (tp !== null) {
    const ok = tp <= -1;
    checks.push({ id: "true_peak", label: "True peak", status: ok ? "pass" : "warn", detail: `${tp.toFixed(1)} dBTP (max −1.0)`, ...(ok ? {} : { fix: "Lower the peak limiter ceiling to −1 dBTP." }) });
  }
  const pause = num("max_pause_s");
  if (pause !== null) {
    const ok = pause <= 0.15;
    checks.push({ id: "pauses", label: "Longest pause", status: ok ? "pass" : "fail", detail: `${pause.toFixed(2)}s (max 0.15s)`, ...(ok ? {} : { fix: "Tighten the cut list around the long pause." }) });
  }
  const bf = num("black_frames");
  if (bf !== null) checks.push({ id: "black_frames", label: "Black frames", status: bf ? "fail" : "pass", detail: bf ? `${bf} found` : "None", ...(bf ? { fix: "Trim the black frames at the cut points." } : {}) });
  const fr = num("freezes");
  if (fr !== null) checks.push({ id: "freeze", label: "Frozen frames", status: fr ? "fail" : "pass", detail: fr ? `${fr} found` : "None" });
  if (typeof q.caption_safe_zone === "string") {
    const ok = q.caption_safe_zone === "pass";
    checks.push({ id: "caption_safe_zone", label: "Caption safe zone", status: ok ? "pass" : "fail", detail: ok ? "Captions clear of the platform buttons" : String(q.caption_safe_zone), ...(ok ? {} : { fix: "Move captions up out of the bottom 20%." }) });
  }
  for (const issue of Array.isArray(q.issues) ? (q.issues as unknown[]) : []) {
    const i = (typeof issue === "string" ? { detail: issue } : issue) as Json;
    checks.push({ id: String(i.id ?? "issue"), label: String(i.label ?? "Issue"), status: "fail", detail: String(i.detail ?? ""), ...(i.fix ? { fix: String(i.fix) } : {}) });
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const ok = q.ok === undefined ? fails === 0 : Boolean(q.ok);
  return { passed: ok, summary: ok ? `QC passed (${checks.length} checks).` : `QC found ${fails} problem${fails === 1 ? "" : "s"}.`, checks };
}

function notesView(raw: unknown): EditJobView["notes"] {
  if (!Array.isArray(raw)) return [];
  return (raw as Json[]).map((n) => ({
    at: String(n.at ?? ""),
    by: String(n.by ?? n.from ?? "someone"),
    version: Number(n.version ?? n.v ?? 1),
    text: String(n.text ?? ""),
    channel: n.source && typeof n.source === "object" ? String((n.source as Json).channel ?? "") || null : null,
  }));
}

function cutSummary(map: unknown): EditJobView["cutSummary"] {
  if (!map || typeof map !== "object") return null;
  const m = map as Json;
  if (Array.isArray(m.keep)) {
    const keep = (m.keep as [number, number][]).reduce((s, [a, b]) => s + (b - a), 0);
    const dropped = Array.isArray(m.dropped) ? (m.dropped as unknown[]).length : 0;
    return { keep: (m.keep as unknown[]).length, dropped, outputS: Math.round(keep * 10) / 10 };
  }
  if (Array.isArray(m.cuts)) {
    const stats = (m.stats ?? {}) as Json;
    return { keep: 0, dropped: (m.cuts as unknown[]).length, outputS: typeof stats.outputS === "number" ? stats.outputS : null };
  }
  return null;
}

export async function contentDetail(id: string): Promise<ContentDetail | null> {
  if (!UUID.test(id)) return null;
  const ws = workspace();
  const [c] = await ws.sql<Json[]>`select * from content where workspace_id = ${ws.id} and id = ${id}`;
  if (!c) return null;

  const [hookRow] = c.hook_id
    ? await ws.sql<Json[]>`select text, pattern, origin, uses, wins, score::text, source_ref from hooks where workspace_id = ${ws.id} and id = ${c.hook_id as string}`
    : [];
  const [kw] = c.keyword_id ? await ws.sql<{ word: string; status: string }[]>`select word, status from keywords where workspace_id = ${ws.id} and id = ${c.keyword_id as string}` : [];
  const [lm] = c.lead_magnet_id
    ? await ws.sql<{ title: string; url: string | null; kind: string }[]>`select title, coalesce(tracked_url, url) as url, kind from lead_magnets where workspace_id = ${ws.id} and id = ${c.lead_magnet_id as string}`
    : [];

  // Where the idea came from.
  const sources: SourceRef[] = [];
  for (const ref of Array.isArray(c.source_refs) ? (c.source_refs as Json[]) : []) {
    const type = String(ref.type ?? "manual");
    const rid = typeof ref.id === "string" ? ref.id : null;
    if (type === "trend" && rid && UUID.test(rid)) {
      const [t] = await ws.sql<{ title: string; url: string; heat: string | null; source_id: string }[]>`
        select title, url, heat::text, source_id from trends where workspace_id = ${ws.id} and id = ${rid}`;
      sources.push({ type: "Trend", label: t?.title ?? "A trend", detail: t?.heat ? `Heat ${Number(t.heat).toFixed(2)}` : null, url: t?.url ?? (ref.url as string) ?? null, href: "/research#trends" });
    } else if (type === "external_post" && rid && UUID.test(rid)) {
      const [e] = await ws.sql<{ author_handle: string; spoken_hook: string | null; caption: string | null; x_score: string | null; url: string }[]>`
        select author_handle, spoken_hook, caption, x_score::text, url from external_posts where workspace_id = ${ws.id} and id = ${rid}`;
      sources.push({
        type: "Outlier remix",
        label: e?.spoken_hook ?? e?.caption ?? "A competitor post",
        detail: e ? `${e.author_handle.startsWith("@") ? e.author_handle : `@${e.author_handle}`}${e.x_score ? ` · ${Number(e.x_score).toFixed(1)}× their usual` : ""}` : null,
        url: e?.url ?? null,
        href: "/research",
      });
    } else if (type === "proof") {
      sources.push({ type: "Proof", label: String(ref.id ?? "proof item").replace(/[-_]/g, " "), detail: "From proof-inventory.yaml", href: "/brand?file=proof-inventory.yaml" });
    } else if (type === "manual") {
      sources.push({ type: "Your idea", label: "Added by hand" });
    } else {
      sources.push({ type: type.replace(/_/g, " "), label: String(ref.id ?? ref.url ?? ""), url: (ref.url as string) ?? null });
    }
  }

  const scripts = await ws.sql<Json[]>`
    select id, version, status, body, beats, hook_text, hook_source, claim_ledger, validator_report, captions, created_by, created_at
      from scripts where workspace_id = ${ws.id} and content_id = ${id} order by version desc`;

  const edits = await ws.sql<Json[]>`
    select e.*, sa.uri as source_uri, sa.duration_s::text as source_duration
      from edit_jobs e left join media_assets sa on sa.id = e.source_asset_id
     where e.workspace_id = ${ws.id} and e.content_id = ${id} order by e.created_at desc`;
  const renders = await ws.sql<{ id: string; uri: string; duration_s: string | null; created_at: Date; provenance: Json | null }[]>`
    select id, uri, duration_s::text, created_at, provenance from media_assets
     where workspace_id = ${ws.id} and content_id = ${id} and kind = 'render' order by created_at asc`;
  const editIds = edits.map((e) => e.id as string);
  const scriptIds = scripts.map((s) => s.id as string);

  const postRows = await ws.sql<Json[]>`
    select p.id, p.platform, p.status, coalesce(p.published_at, p.scheduled_at) as at, p.caption, p.url, p.error, p.utm_content, p.is_trial,
           m.snapshot as m_snapshot, m.captured_at as m_captured, m.views::text, m.likes::text, m.comments::text, m.shares::text,
           m.saves::text, m.follows::text, m.leads, m.completion_rate::text, m.x_score::text
      from posts p
      left join lateral (select * from post_metrics pm where pm.post_id = p.id order by pm.captured_at desc limit 1) m on true
     where p.workspace_id = ${ws.id} and p.content_id = ${id} and p.status <> 'cancelled'
     order by coalesce(p.published_at, p.scheduled_at) asc nulls last, p.platform`;
  const postIds = postRows.map((p) => p.id as string);

  const pending = await ws.sql<{ id: string; ref: string; kind: string; summary: string; agent: string; subject_id: string | null }[]>`
    select id, ref, kind, summary, agent, subject_id from approvals
     where workspace_id = ${ws.id} and status = 'pending'
       and (subject_id = ${id} or subject_id = any(${[...editIds, ...scriptIds, ...postIds]}::uuid[]))
     order by requested_at asc`;

  const [thumbRow] = await ws.sql<{ id: string; uri: string }[]>`
    select id, uri from media_assets where workspace_id = ${ws.id} and content_id = ${id} and kind in ('thumbnail', 'image') order by created_at desc limit 1`;

  const thumb = thumbRow && mediaOnDisk(thumbRow.uri) ? thumbRow : undefined;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

  return {
    id,
    title: String(c.title),
    status: String(c.status),
    kind: String(c.kind),
    lane: (c.lane as string) ?? null,
    pillar: (c.pillar as string) ?? null,
    funnel: (c.funnel_stage as string) ?? null,
    angle: (c.angle as string) ?? null,
    storyStructure: (c.story_structure as string) ?? null,
    template: (c.template as string) ?? null,
    hookPattern: (c.hook_pattern as string) ?? null,
    ctaType: (c.cta_type as string) ?? null,
    postNumber: (c.post_number as number) ?? null,
    filmBy: iso(c.film_by),
    deadlineAt: iso(c.deadline_at),
    createdBy: String(c.created_by),
    createdAt: iso(c.created_at)!,
    updatedAt: iso(c.updated_at)!,
    publishedAt: iso(c.published_at),
    brief: (c.brief as ContentDetail["brief"]) ?? null,
    hook: hookRow
      ? {
          text: String(hookRow.text),
          pattern: String(hookRow.pattern),
          origin: String(hookRow.origin),
          uses: Number(hookRow.uses ?? 0),
          wins: Number(hookRow.wins ?? 0),
          score: hookRow.score === null || hookRow.score === undefined ? null : Number(hookRow.score),
          sourceLabel: (() => {
            const s = (hookRow.source_ref ?? null) as Json | null;
            if (!s) return null;
            if (s.author) return `from ${String(s.author)}`;
            if (s.post_id) return "from one of your own posts";
            if (s.external_post_id) return "from a competitor outlier (structure only)";
            return null;
          })(),
        }
      : null,
    keyword: kw ?? null,
    leadMagnet: lm ?? null,
    sources,
    thumbId: thumb?.id ?? null,
    scripts: scripts.map((s) => ({
      id: s.id as string,
      version: Number(s.version),
      status: String(s.status),
      body: String(s.body),
      beats: Array.isArray(s.beats) ? (s.beats as Beat[]) : [],
      hookText: (s.hook_text as string) ?? null,
      hookSource: (s.hook_source as ScriptVersion["hookSource"]) ?? null,
      claims: Array.isArray(s.claim_ledger) ? (s.claim_ledger as Claim[]) : [],
      validator: (s.validator_report as ScriptVersion["validator"]) ?? null,
      captions: (s.captions as CaptionSet) ?? null,
      createdBy: String(s.created_by),
      createdAt: iso(s.created_at)!,
    })),
    edits: edits.map((e) => {
      const forJob = renders.filter((r) => (!r.uri.includes("/renders/") || r.uri.includes(`/${e.ref as string}/`)) && mediaOnDisk(r.uri));
      return {
        id: e.id as string,
        ref: String(e.ref),
        status: String(e.status),
        version: Number(e.version),
        format: (e.format as string) ?? null,
        engine: String(e.engine),
        createdAt: iso(e.created_at)!,
        updatedAt: iso(e.updated_at)!,
        costUsd: Number(e.cost_micro ?? 0) / 1e6,
        renders: forJob.map((r, i) => ({
          assetId: r.id,
          version: Number((r.provenance as Json | null)?.version ?? i + 1),
          durationS: r.duration_s === null ? null : Number(r.duration_s),
          createdAt: r.created_at.toISOString(),
          uri: r.uri,
        })),
        outputAssetId: (e.output_asset_id as string) ?? null,
        sourceAsset: e.source_asset_id ? { id: e.source_asset_id as string, uri: String(e.source_uri ?? ""), durationS: e.source_duration ? Number(e.source_duration) : null } : null,
        qc: qcView(e.qc_report),
        preflight: (e.preflight as Json) ?? null,
        plan: (e.plan as Json) ?? null,
        cutSummary: cutSummary(e.edit_map),
        notes: notesView(e.notes),
        pendingApproval: (() => {
          const p = pending.find((a) => a.subject_id === e.id);
          return p ? { ref: p.ref, summary: p.summary } : null;
        })(),
      };
    }),
    posts: postRows.map((p) => ({
      id: p.id as string,
      contentId: id,
      title: String(c.title),
      contentStatus: String(c.status),
      kind: String(c.kind),
      platform: String(p.platform),
      status: String(p.status),
      at: iso(p.at) ?? "",
      caption: (p.caption as string) ?? null,
      url: (p.url as string) ?? null,
      error: (p.error as string) ?? null,
      utm: (p.utm_content as string) ?? null,
      thumbId: thumb?.id ?? null,
      metrics: toMetrics(p as never),
      trial: p.is_trial === true,
      trialProofNeeded: false,
    })),
    pending: pending.map((p) => ({ ref: p.ref, kind: p.kind, summary: p.summary, agent: p.agent })),
  };
}

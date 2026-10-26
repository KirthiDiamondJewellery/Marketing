import "server-only";
import { workspace } from "@/server/workspace";
import { getUploads, productionReady, shootNotes, type ShootNotes, type UploadView } from "./production";
import { groupFilm, type FilmRow, type IdeaState } from "./film-groups";

/**
 * The Film page: scripts ready to film with their shoot directions, scripts waiting for the owner's OK, the ideas
 * that still need a script (and the Copywriter's progress on them), and the takes uploaded so far.
 */

export type FilmScript = {
  id: string;
  title: string;
  status: string;
  hook: string | null;
  body: string;
  beats: { role: string; text: string }[];
  keyword: string | null;
  format: string | null;
  formatName: string | null;
  shoot: ShootNotes | null;
  why: string | null;
  filmBy: string | null;
  filmedAt: string | null;
  takes: number;
  version: number | null;
  /** Pending approval for this version (the "Waiting for your OK" group). */
  approval: { id: string; ref: string } | null;
  claims: { pass: number; fix: number; cut: number };
};

export type FilmIdea = {
  id: string;
  title: string;
  why: string | null;
  kind: string | null;
  formatName: string | null;
  filmBy: string | null;
  state: IdeaState;
};

export type FilmData = {
  scripts: FilmScript[];
  waiting: FilmScript[];
  ideas: FilmIdea[];
  /** write-script runs in flight: running now, and queued (some start later on purpose). */
  copywriter: { running: number; queued: number; titles: string[] };
  uploads: UploadView[];
  ready: boolean;
  editingOn: boolean;
  tz: string;
};

type Row = FilmRow & {
  title: string;
  template: string | null;
  brief: Record<string, unknown> | null;
  film_by: Date | null;
  keyword: string | null;
  body: string | null;
  hook: string | null;
  beats: unknown;
  claim_ledger: unknown;
  takes: number;
};

const KIND_LABEL: Record<string, string> = { news: "News reel", remix: "Outlier remix", talking_head: "Talking head", offer: "Offer piece" };

function claimCounts(ledger: unknown): FilmScript["claims"] {
  const out = { pass: 0, fix: 0, cut: 0 };
  if (!Array.isArray(ledger)) return out;
  for (const c of ledger as { verdict?: unknown }[]) {
    const v = String(c?.verdict ?? "").toUpperCase();
    if (v === "PASS") out.pass++;
    else if (v === "FIX") out.fix++;
    else if (v === "CUT") out.cut++;
  }
  return out;
}

function toScript(r: Row): FilmScript {
  const b = r.brief ?? {};
  const shoot = shootNotes(r.template);
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    hook: r.hook,
    body: r.body ?? "",
    beats: Array.isArray(r.beats) ? (r.beats as { role?: unknown; text?: unknown }[]).flatMap((x) => (typeof x.text === "string" ? [{ role: String(x.role ?? ""), text: x.text }] : [])) : [],
    keyword: (r.keyword ?? (typeof b.keyword === "string" ? b.keyword : null))?.toUpperCase() ?? null,
    format: r.template,
    formatName: shoot?.name ?? (r.template ? r.template.replace(/-/g, " ") : null),
    shoot,
    why: typeof b.why === "string" ? b.why : null,
    filmBy: r.film_by?.toISOString() ?? null,
    filmedAt: typeof b.filmed_at === "string" ? b.filmed_at : null,
    takes: r.takes,
    version: r.script?.version ?? null,
    approval: r.approval,
    claims: claimCounts(r.claim_ledger),
  };
}

/** Used by an unfinished feature (see components/UNFINISHED.md). */
export async function getFilmData(): Promise<FilmData> {
  const ws = workspace();
  const ready = await productionReady().catch(() => false);
  const rows = await ws.sql<(Omit<Row, "script" | "approval"> & {
    script_id: string | null; script_version: number | null; script_status: string | null; script_ok: boolean | null;
    approval_id: string | null; approval_ref: string | null;
  })[]>`
    select c.id, c.title, c.status, c.kind, c.template, c.brief, c.film_by, k.word::text as keyword,
           s.id as script_id, s.version as script_version, s.status as script_status, s.ok as script_ok,
           s.body, s.hook_text as hook, s.beats, s.claim_ledger,
           a.id as approval_id, a.ref as approval_ref,
           exists (
             select 1 from agent_runs r
              where r.workspace_id = c.workspace_id and r.job_id = 'scripting.write-script' and r.status in ('queued', 'running')
                and r.input ->> 'contentId' = c.id::text
           ) as writing,
           ${ready ? ws.sql`(select count(*)::int from production_uploads u where u.workspace_id = c.workspace_id and u.content_id = c.id and u.status = 'linked')` : ws.sql`0`} as takes
      from content c
      left join keywords k on k.id = c.keyword_id and k.workspace_id = c.workspace_id
      left join lateral (
        select id, version, status, body, hook_text, beats, claim_ledger, (validator_report ->> 'ok')::boolean as ok from scripts
         where content_id = c.id and workspace_id = c.workspace_id and status <> 'superseded'
         order by version desc limit 1
      ) s on true
      left join lateral (
        select id, ref from approvals
         where workspace_id = c.workspace_id and status = 'pending' and kind = 'script' and subject_type = 'script' and subject_id = s.id
         order by requested_at desc limit 1
      ) a on true
     where c.workspace_id = ${ws.id} and c.status in ('idea', 'scripted', 'filming') and c.kind not in ('text', 'carousel')
     order by c.film_by asc nulls last, c.created_at asc
     limit 80`;
  const grouped = groupFilm<Row>(
    rows.map((r) => ({
      ...r,
      script: r.script_id ? { id: r.script_id, version: r.script_version ?? 1, status: r.script_status ?? "draft", ok: r.script_ok } : null,
      approval: r.approval_id && r.approval_ref ? { id: r.approval_id, ref: r.approval_ref } : null,
    })),
  );
  const ideas = grouped.ideas.slice(0, 20).map<FilmIdea>((r) => {
    const b = r.brief ?? {};
    const kind = typeof b.kind === "string" ? b.kind : null;
    return {
      id: r.id,
      title: r.title,
      why: typeof b.why === "string" ? b.why : null,
      kind: kind ? (KIND_LABEL[kind] ?? kind.replace(/_/g, " ")) : null,
      formatName: shootNotes(r.template)?.name ?? (r.template ? r.template.replace(/-/g, " ") : null),
      filmBy: r.film_by?.toISOString() ?? null,
      state: r.state,
    };
  });

  const runs = await ws.sql<{ status: string; title: string | null }[]>`
    select r.status, c.title from agent_runs r
      left join content c on c.workspace_id = r.workspace_id and c.id::text = r.input ->> 'contentId'
     where r.workspace_id = ${ws.id} and r.job_id = 'scripting.write-script' and r.status in ('queued', 'running')
     order by (r.status = 'running') desc, r.run_after asc
     limit 20`;
  const copywriter = {
    running: runs.filter((r) => r.status === "running").length,
    queued: runs.filter((r) => r.status === "queued").length,
    titles: runs.flatMap((r) => (r.title ? [r.title] : [])).slice(0, 5),
  };

  const uploads = ready ? await getUploads() : [];
  const editingOn = ws.config.modules.editing?.enabled !== false;
  return {
    scripts: grouped.ready.slice(0, 40).map(toScript),
    waiting: grouped.waiting.slice(0, 20).map(toScript),
    ideas,
    copywriter,
    uploads,
    ready,
    editingOn,
    tz: ws.config.workspace.timezone,
  };
}

/** Scripts a take can be linked to (the Film list plus anything already in the edit), for the "pick another" menu. */
export async function getLinkableScripts(): Promise<{ id: string; title: string; status: string }[]> {
  const ws = workspace();
  return ws.sql<{ id: string; title: string; status: string }[]>`
    select c.id, c.title, c.status from content c
     where c.workspace_id = ${ws.id} and c.status in ('idea', 'scripted', 'filming', 'editing', 'review')
       and exists (select 1 from scripts s where s.content_id = c.id and s.workspace_id = c.workspace_id)
     order by (c.status in ('scripted', 'filming')) desc, c.film_by asc nulls last, c.updated_at desc
     limit 50`;
}

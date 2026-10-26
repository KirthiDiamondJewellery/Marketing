import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { workspace } from "@/server/workspace";
import { engineRoot } from "@/server/settings";

/**
 * Shared reads for the production loop (Film → Upload → Edits → Approvals → Scheduled): the format templates' shoot
 * directions, uploaded takes and the Home "Today" strip. The writes live in @attentionos/module-production/repo.
 */

let tablesChecked: boolean | null = null;

/** True once the production module's tables exist (the module is on and its migration ran). */
export async function productionReady(): Promise<boolean> {
  if (tablesChecked) return true;
  const ws = workspace();
  const [row] = await ws.sql<{ ok: boolean }[]>`select to_regclass('production_uploads') is not null and to_regclass('production_releases') is not null as ok`;
  tablesChecked = row?.ok ?? false;
  return tablesChecked;
}

/** The production module is on (default) and its tables exist. */
export async function productionOn(): Promise<boolean> {
  const ws = workspace();
  if (ws.config.modules.production?.enabled === false) return false;
  return productionReady().catch(() => false);
}

// ───────────────────────────── Formats and shoot directions ─────────────────────────────

export type ShootSection = { label: string; text: string | null; bullets: string[] };
export type ShootNotes = { id: string; name: string; sections: ShootSection[] };

function formatsDir(): string | null {
  const candidates = [
    process.env.ATTENTIONOS_FORMATS_DIR,
    engineRoot() ? join(engineRoot()!, "templates", "formats") : null,
    join(workspace().root, "formats"),
    resolve(process.cwd(), "../../templates/formats"),
  ].filter((d): d is string => Boolean(d));
  return candidates.find((d) => existsSync(d)) ?? null;
}

/** "**Framing.** text" paragraphs and "- bullet" lists from a format's shoot.md. */
export function parseShoot(md: string): ShootSection[] {
  const out: ShootSection[] = [];
  let cur: ShootSection | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("# ")) continue;
    const head = /^\*\*(.+?)\.?\*\*\s*(.*)$/.exec(line);
    if (head) {
      cur = { label: head[1]!.replace(/\.$/, ""), text: head[2]?.trim() || null, bullets: [] };
      out.push(cur);
    } else if (/^[-*]\s+/.test(line) && cur) {
      cur.bullets.push(line.replace(/^[-*]\s+/, ""));
    } else if (cur) {
      cur.text = cur.text ? `${cur.text} ${line}` : line;
    }
  }
  return out;
}

const shootCache = new Map<string, ShootNotes | null>();

export function shootNotes(formatId: string | null | undefined): ShootNotes | null {
  const id = formatId || "raw-talking-head";
  if (shootCache.has(id)) return shootCache.get(id)!;
  let notes: ShootNotes | null = null;
  const dir = formatsDir();
  if (dir && /^[a-z0-9-]+$/.test(id)) {
    const file = join(dir, id, "shoot.md");
    if (existsSync(file)) {
      let name = id.replace(/-/g, " ");
      try {
        const f = JSON.parse(readFileSync(join(dir, id, "format.json"), "utf8")) as { name?: string };
        if (f.name) name = f.name;
      } catch {
        // name stays the id
      }
      notes = { id, name, sections: parseShoot(readFileSync(file, "utf8")) };
    }
  }
  shootCache.set(id, notes);
  return notes;
}

// ───────────────────────────── Uploaded takes ─────────────────────────────

export type UploadCandidate = { contentId: string; title: string; score: number; hookScore: number; reason: string };

export type UploadView = {
  id: string;
  fileName: string;
  bytes: number | null;
  durationS: number | null;
  status: "matching" | "suggested" | "linked" | "unmatched" | "failed" | "dismissed";
  role: "edit" | "take" | null;
  contentId: string | null;
  contentTitle: string | null;
  confidence: number | null;
  linkedBy: string | null;
  candidates: UploadCandidate[];
  transcript: string | null;
  error: string | null;
  editRef: string | null;
  editStatus: string | null;
  assetId: string | null;
  coverId: string | null;
  createdAt: string;
};

type UploadRowDb = {
  id: string; file_name: string; bytes: string | null; duration_s: string | null; status: UploadView["status"]; role: UploadView["role"];
  content_id: string | null; title: string | null; confidence: string | null; linked_by: string | null; candidates: UploadCandidate[] | null;
  transcript: string | null; error: string | null; ref: string | null; edit_status: string | null; asset_id: string | null; cover_id: string | null; created_at: Date;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function getUploads(opts: { days?: number; limit?: number } = {}): Promise<UploadView[]> {
  if (!(await productionReady())) return [];
  const ws = workspace();
  const rows = await ws.sql<UploadRowDb[]>`
    select u.id, u.file_name, u.bytes::text, u.duration_s::text, u.status, u.role, u.content_id, c.title, u.confidence::text, u.linked_by,
           u.candidates, u.transcript, u.error, e.ref, e.status as edit_status, u.asset_id,
           (select t.id from media_assets t where t.workspace_id = u.workspace_id and t.kind = 'thumbnail' and t.provenance->>'uploadId' = u.id::text limit 1) as cover_id,
           u.created_at
      from production_uploads u
      left join content c on c.id = u.content_id
      left join edit_jobs e on e.id = u.edit_job_id
     where u.workspace_id = ${ws.id} and u.status <> 'dismissed' and u.created_at > now() - make_interval(days => ${opts.days ?? 14})
     order by u.created_at desc
     limit ${opts.limit ?? 60}`;
  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    bytes: num(r.bytes),
    durationS: num(r.duration_s),
    status: r.status,
    role: r.role,
    contentId: r.content_id,
    contentTitle: r.title,
    confidence: num(r.confidence),
    linkedBy: r.linked_by,
    candidates: Array.isArray(r.candidates) ? r.candidates : [],
    transcript: r.transcript,
    error: r.error,
    editRef: r.ref,
    editStatus: r.edit_status,
    assetId: r.asset_id,
    coverId: r.cover_id,
    createdAt: r.created_at.toISOString(),
  }));
}

// ───────────────────────────── Home: the loop at a glance ─────────────────────────────

export type TodayStrip = { film: number; upload: number; editing: number; review: number; scheduled: number; nextPost: string | null; ready: boolean };

/** Used by an unfinished feature (see components/UNFINISHED.md). */
export async function getTodayStrip(): Promise<TodayStrip> {
  const ws = workspace();
  const ready = await productionReady().catch(() => false);
  const [row] = await ws.sql<{ film: number; editing: number; review: number; scheduled: number; next_post: Date | null }[]>`
    select
      (select count(*)::int from content where workspace_id = ${ws.id} and status in ('scripted', 'filming')) as film,
      (select count(*)::int from edit_jobs e where e.workspace_id = ${ws.id}
          and (e.status in ('queued', 'prepping', 'planning', 'rendering', 'qc')
               or (e.status = 'review' and not exists (select 1 from approvals a where a.workspace_id = e.workspace_id and a.subject_id = e.id and a.status = 'pending' and a.subject_type in ('edit_render', 'edit_job'))
                   and exists (select 1 from approvals a where a.workspace_id = e.workspace_id and a.subject_id = e.id and a.status = 'revised')))) as editing,
      (select count(*)::int from approvals where workspace_id = ${ws.id} and status = 'pending' and kind = 'edit') as review,
      (select count(*)::int from posts where workspace_id = ${ws.id} and status in ('scheduled', 'queued', 'assist') and (scheduled_at is null or scheduled_at > now())) as scheduled,
      (select min(scheduled_at) from posts where workspace_id = ${ws.id} and status in ('scheduled', 'queued', 'assist') and scheduled_at > now()) as next_post`;
  let upload = 0;
  if (ready) {
    const [u] = await ws.sql<{ n: number }[]>`
      select count(*)::int as n from production_uploads where workspace_id = ${ws.id} and status in ('matching', 'suggested', 'unmatched') and created_at > now() - interval '14 days'`;
    upload = u?.n ?? 0;
  }
  return {
    film: row?.film ?? 0,
    upload,
    editing: row?.editing ?? 0,
    review: row?.review ?? 0,
    scheduled: row?.scheduled ?? 0,
    nextPost: row?.next_post?.toISOString() ?? null,
    ready,
  };
}

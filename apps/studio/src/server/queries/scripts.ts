import "server-only";
import { workspace } from "@/server/workspace";
import { shootNotes } from "./production";

/**
 * The Scripts page: every filmable piece that has a script (or is getting one), in plain states:
 *
 * - writing:   the Copywriter is writing it (no usable script yet), or rewriting it from your notes (`rewriting`)
 * - needs_ok:  the newest version passed every check and waits for your OK
 * - draft:     a draft that missed a check or was never sent for an OK: you can edit it or tell the AI what to change
 * - ready:     approved, ready to film
 * - filmed:    marked as filmed, waiting for the footage
 * - stuck:     you asked for it but the AI couldn't finish (or never started): try again or delete it
 *
 * Ideas the Strategist planned that nobody asked to script yet aren't cards; they only feed the "Write scripts for
 * today" button (`ideasWithoutScript`).
 */

export type ScriptState = "writing" | "needs_ok" | "draft" | "ready" | "filmed" | "stuck";

export type ScriptCaption = { platform: string; text: string };

export type ScriptItem = {
  id: string;
  title: string;
  state: ScriptState;
  /** A rewrite from your notes is running on top of an existing script. */
  rewriting: boolean;
  contentStatus: string;
  hook: string | null;
  body: string;
  beats: { role: string; text: string }[];
  captions: ScriptCaption[];
  keyword: string | null;
  cta: string | null;
  formatName: string | null;
  kind: string | null;
  why: string | null;
  /** Remixes: the proven post this script remakes ("Based on @handle's reel, 1.2M views, 14x their normal"). */
  basedOn: { line: string; url: string } | null;
  filmBy: string | null;
  filmedAt: string | null;
  version: number | null;
  /** Who wrote this version: you, or the Copywriter. */
  byYou: boolean;
  approvalId: string | null;
  createdAt: string;
};

export type ScriptsData = {
  items: ScriptItem[];
  /** Planned ideas with no script and nobody writing one (for "Write scripts for today"). */
  ideasWithoutScript: string[];
  tz: string;
};

const KIND_LABEL: Record<string, string> = { news: "News reel", remix: "Remix", talking_head: "Talking head", offer: "Offer piece" };

const CTA_LABEL: Record<string, (kw: string | null) => string> = {
  comment_keyword: (kw) => (kw ? `Comment “${kw}”` : "Comment a keyword"),
  dm_keyword: (kw) => (kw ? `DM “${kw}”` : "DM a keyword"),
  link_in_bio: () => "Link in bio",
  follow: () => "Follow for more",
  save_share: () => "Save and share",
  book_call: () => "Book a call",
};

const STATE_ORDER: Record<ScriptState, number> = { writing: 0, needs_ok: 1, draft: 2, stuck: 3, ready: 4, filmed: 5 };

type Row = {
  id: string;
  title: string;
  status: string;
  kind: string;
  template: string | null;
  brief: Record<string, unknown> | null;
  film_by: Date | null;
  cta_type: string | null;
  keyword: string | null;
  created_at: Date;
  script_id: string | null;
  script_version: number | null;
  script_status: string | null;
  script_ok: boolean | null;
  script_by: string | null;
  body: string | null;
  hook: string | null;
  beats: unknown;
  captions: unknown;
  approval_id: string | null;
  writing: boolean;
  revising: boolean;
  last_run: string | null;
};

function captionList(raw: unknown): ScriptCaption[] {
  if (!raw || typeof raw !== "object") return [];
  const out: ScriptCaption[] = [];
  for (const [platform, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const main = [c.title, c.caption ?? c.text ?? c.description].filter((x): x is string => typeof x === "string" && x.trim().length > 0).join("\n");
    const tags = Array.isArray(c.hashtags) ? c.hashtags.filter((t): t is string => typeof t === "string").map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ") : "";
    const text = [main, tags].filter(Boolean).join("\n\n");
    if (text) out.push({ platform, text });
  }
  return out;
}

function basedOn(raw: unknown): ScriptItem["basedOn"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { line?: unknown; url?: unknown };
  return typeof r.line === "string" && typeof r.url === "string" && /^https:\/\//i.test(r.url) ? { line: r.line, url: r.url } : null;
}

export function scriptState(r: Pick<Row, "status" | "script_status" | "script_ok" | "approval_id" | "writing" | "last_run" | "brief" | "script_id">): ScriptState | null {
  if (r.status === "filming" && r.script_id) return "filmed";
  if (r.script_status === "approved" && r.status === "scripted") return "ready";
  if (r.writing) return "writing";
  if (r.script_status === "draft") return r.script_ok === true ? "needs_ok" : "draft";
  if (r.script_status === null) {
    // Asked for from Studio (or tried and failed) but nothing came back: say so instead of hiding it.
    if (r.last_run === "failed" || r.last_run === "cancelled") return "stuck";
    if ((r.brief ?? {}).source === "studio") return "stuck";
  }
  return null;
}

export async function getScriptsData(): Promise<ScriptsData> {
  const ws = workspace();
  const rows = await ws.sql<Row[]>`
    select c.id, c.title, c.status, c.kind, c.template, c.brief, c.film_by, c.cta_type, c.created_at, k.word::text as keyword,
           s.id as script_id, s.version as script_version, s.status as script_status, s.ok as script_ok, s.created_by as script_by,
           s.body, s.hook_text as hook, s.beats, s.captions,
           a.id as approval_id,
           w.id is not null as writing,
           coalesce(w.revising, false) as revising,
           lr.status as last_run
      from content c
      left join keywords k on k.id = c.keyword_id and k.workspace_id = c.workspace_id
      left join lateral (
        select id, version, status, body, hook_text, beats, captions, created_by, (validator_report ->> 'ok')::boolean as ok from scripts
         where content_id = c.id and workspace_id = c.workspace_id and status in ('draft', 'approved')
         order by version desc limit 1
      ) s on true
      left join lateral (
        select id from approvals
         where workspace_id = c.workspace_id and status = 'pending' and kind = 'script' and subject_type = 'script' and subject_id = s.id
         order by requested_at desc limit 1
      ) a on true
      left join lateral (
        select r.id, (r.input -> 'revise') is not null as revising from agent_runs r
         where r.workspace_id = c.workspace_id and r.job_id = 'scripting.write-script' and r.status in ('queued', 'running')
           and r.input ->> 'contentId' = c.id::text
         order by r.created_at desc limit 1
      ) w on true
      left join lateral (
        select r.status from agent_runs r
         where r.workspace_id = c.workspace_id and r.job_id = 'scripting.write-script' and r.input ->> 'contentId' = c.id::text
         order by r.created_at desc limit 1
      ) lr on true
     where c.workspace_id = ${ws.id} and c.status in ('idea', 'scripted', 'filming') and c.kind not in ('text', 'carousel')
     order by c.film_by asc nulls last, c.created_at desc
     limit 200`;

  const items: ScriptItem[] = [];
  const ideasWithoutScript: string[] = [];
  for (const r of rows) {
    const state = scriptState(r);
    if (!state) {
      if (!r.script_id && !r.writing && r.status === "idea" && !r.last_run) ideasWithoutScript.push(r.id);
      continue;
    }
    const b = r.brief ?? {};
    const kind = typeof b.kind === "string" ? b.kind : null;
    const keyword = (r.keyword ?? (typeof b.keyword === "string" ? b.keyword : null))?.toUpperCase() ?? null;
    items.push({
      id: r.id,
      title: r.title,
      state,
      rewriting: r.writing && Boolean(r.script_id),
      contentStatus: r.status,
      hook: r.hook,
      body: r.body ?? "",
      beats: Array.isArray(r.beats) ? (r.beats as { role?: unknown; text?: unknown }[]).flatMap((x) => (typeof x.text === "string" && x.text.trim() ? [{ role: String(x.role ?? ""), text: x.text }] : [])) : [],
      captions: captionList(r.captions),
      keyword,
      cta: r.cta_type && CTA_LABEL[r.cta_type] ? CTA_LABEL[r.cta_type]!(keyword) : null,
      formatName: r.template ? (shootNotes(r.template)?.name ?? r.template.replace(/-/g, " ")) : null,
      kind: kind ? (KIND_LABEL[kind] ?? kind.replace(/_/g, " ")) : null,
      why: typeof b.notes === "string" ? b.notes : typeof b.why === "string" ? b.why : null,
      basedOn: basedOn(b.remixOf),
      filmBy: r.film_by?.toISOString() ?? null,
      filmedAt: typeof b.filmed_at === "string" ? b.filmed_at : null,
      version: r.script_version,
      byYou: (r.script_by ?? "").startsWith("user:"),
      approvalId: r.approval_id,
      createdAt: r.created_at.toISOString(),
    });
  }
  // Writing first (so a fresh request shows up on top), then what needs you, then what's ready to film.
  items.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  return { items, ideasWithoutScript: ideasWithoutScript.slice(0, 20), tz: ws.config.workspace.timezone };
}

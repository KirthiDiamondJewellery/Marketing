import "server-only";
import { workspace } from "@/server/workspace";

/** Approval queue with everything a card needs: the platform preview, the reasoning and where to edit. */

export type CaptionPreview = { platform: string; text: string; hashtags: string[] };

export type PreviewModel =
  | {
      type: "video";
      ref: string | null;
      version: number | null;
      assetId: string | null;
      src: string | null;
      width: number;
      height: number;
      durationS: number | null;
      title: string | null;
      caption: CaptionPreview | null;
      notes: string[];
      qc: string[];
      /** Everything the video review card needs (final videos from the edit pipeline). */
      review: VideoReview | null;
    }
  | {
      type: "script";
      title: string | null;
      hook: string | null;
      body: string;
      beats: { role: string; text: string }[];
      captions: CaptionPreview[];
      keyword: string | null;
      claims: { claim: string; verdict: string; note: string | null; source: string | null }[];
      version: number | null;
    }
  | {
      type: "post";
      platform: string;
      title: string | null;
      caption: string;
      hashtags: string[];
      assist: boolean;
      media: { assetId: string; src: string; width: number; height: number; durationS: number | null } | null;
    }
  | {
      type: "reply";
      platform: string;
      channel: "dm" | "comment";
      from: string | null;
      incoming: string | null;
      draft: string;
      temperature: string | null;
      reason: string | null;
    }
  | { type: "text"; text: string };

export type ReasonPoint = { label: string; text: string };

export type QcCheck = { label: string; status: "pass" | "warn" | "fail" | string; detail: string | null };
export type PlannedSlot = { platform: string; scheduledAt: string | null; mode: "auto" | "assist" };
export type VideoVersion = { version: number; assetId: string; src: string; durationS: number | null };
export type VideoReview = {
  editId: string;
  editRef: string;
  contentId: string | null;
  versions: VideoVersion[];
  captions: { platform: string; text: string }[];
  slots: PlannedSlot[];
  qc: { passed: boolean | null; summary: string | null; checks: QcCheck[] };
  history: { version: number; text: string; at: string | null }[];
  publisherAutopilot: boolean;
  instagramAutopost: boolean;
  hasPublisher: boolean;
};

export type ApprovalView = {
  id: string;
  ref: string;
  kind: string;
  agent: string;
  status: string;
  summary: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  title: string;
  scheduledFor: string | null;
  platforms: string[];
  preview: PreviewModel;
  why: { points: ReasonPoint[]; steps: { ts: string; agent: string; message: string }[] };
  editHref: string | null;
};

type ApprovalRow = {
  id: string; ref: string; kind: string; subject_type: string; subject_id: string | null; agent: string; status: string;
  summary: string; preview: Record<string, unknown> | null; run_id: string | null; requested_at: Date; decided_at: Date | null;
  decided_by: string | null; decision_note: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function captionsFrom(raw: unknown): CaptionPreview[] {
  if (!raw || typeof raw !== "object") return [];
  const order = ["instagram", "tiktok", "youtube", "linkedin", "facebook", "x", "threads"];
  return Object.entries(raw as Record<string, Record<string, unknown>>)
    .map(([platform, c]) => ({
      platform,
      text: str(c?.caption) ?? str(c?.text) ?? [str(c?.title), str(c?.description)].filter(Boolean).join("\n\n"),
      hashtags: Array.isArray(c?.hashtags) ? (c.hashtags as unknown[]).filter((h): h is string => typeof h === "string") : [],
    }))
    .filter((c) => c.text)
    .sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
}

/** Pulls hashtags off the end of a caption so the preview can set them apart. */
function splitHashtags(caption: string): { text: string; hashtags: string[] } {
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  const text = caption.replace(/(\s*#[\p{L}\p{N}_]+)+\s*$/u, "").trim();
  return { text, hashtags: tags };
}

export async function getApprovalQueue(opts: { status?: "pending" | "decided"; limit?: number } = {}): Promise<{ items: ApprovalView[]; total: number }> {
  const ws = workspace();
  const sql = ws.sql;
  const status = opts.status ?? "pending";
  const limit = Math.min(opts.limit ?? 50, 100);
  const rows = await sql<ApprovalRow[]>`
    select id, ref, kind, subject_type, subject_id, agent, status, summary, preview, run_id, requested_at, decided_at, decided_by, decision_note
      from approvals
     where workspace_id = ${ws.id} and ${status === "pending" ? sql`status = 'pending'` : sql`status <> 'pending'`}
     order by ${status === "pending" ? sql`requested_at asc` : sql`decided_at desc nulls last`}
     limit ${limit}`;
  const [count] = await sql<{ n: number }[]>`
    select count(*)::int as n from approvals where workspace_id = ${ws.id} and ${status === "pending" ? sql`status = 'pending'` : sql`status <> 'pending'`}`;
  const items = await Promise.all(rows.map((r) => enrich(r).catch((e) => fallbackView(r, e))));
  return { items, total: count?.n ?? items.length };
}

function baseView(r: ApprovalRow): Omit<ApprovalView, "preview" | "why" | "title" | "scheduledFor" | "platforms" | "editHref"> {
  return {
    id: r.id,
    ref: r.ref,
    kind: r.kind,
    agent: r.agent,
    status: r.status,
    summary: r.summary,
    requestedAt: r.requested_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
    decidedBy: r.decided_by,
    note: r.decision_note,
  };
}

function fallbackView(r: ApprovalRow, e: unknown): ApprovalView {
  console.warn("[studio] approval preview failed:", r.ref, e instanceof Error ? e.message : e);
  return {
    ...baseView(r),
    title: r.summary,
    scheduledFor: null,
    platforms: [],
    preview: { type: "text", text: r.summary },
    why: { points: [], steps: [] },
    editHref: null,
  };
}

async function enrich(r: ApprovalRow): Promise<ApprovalView> {
  const ws = workspace();
  const sql = ws.sql;
  const p = r.preview ?? {};
  const points: ReasonPoint[] = [];
  let preview: PreviewModel = { type: "text", text: r.summary };
  let title = r.summary.replace(/^[^:]{1,24}:\s*/, "").replace(/^"(.*)"$/, "$1");
  let scheduledFor: string | null = str(p.scheduled_at);
  let platforms: string[] = str(p.platform) ? [str(p.platform)!] : [];
  let contentId: string | null = null;

  if (r.subject_type === "script" && r.subject_id) {
    const [s] = await sql<{
      content_id: string; version: number; body: string; beats: unknown; hook_text: string | null; captions: unknown; claim_ledger: unknown;
      title: string; brief: Record<string, unknown> | null; keyword: string | null; film_by: Date | null; lane: string | null; funnel_stage: string | null;
    }[]>`
      select s.content_id, s.version, s.body, s.beats, s.hook_text, s.captions, s.claim_ledger, c.title, c.brief, k.word::text as keyword, c.film_by, c.lane, c.funnel_stage
        from scripts s join content c on c.id = s.content_id
        left join keywords k on k.id = c.keyword_id
       where s.id = ${r.subject_id} and s.workspace_id = ${ws.id}`;
    if (s) {
      contentId = s.content_id;
      title = s.title;
      const captions = captionsFrom(s.captions);
      platforms = captions.map((c) => c.platform);
      preview = {
        type: "script",
        title: s.title,
        hook: s.hook_text ?? str(p.hook),
        body: s.body,
        beats: Array.isArray(s.beats) ? (s.beats as { role?: unknown; text?: unknown }[]).flatMap((b) => (typeof b.text === "string" ? [{ role: String(b.role ?? ""), text: b.text }] : [])) : [],
        captions,
        keyword: (s.keyword ?? str(p.keyword))?.toUpperCase() ?? null,
        claims: Array.isArray(s.claim_ledger)
          ? (s.claim_ledger as Record<string, unknown>[]).map((c) => ({ claim: String(c.claim ?? ""), verdict: String(c.verdict ?? "").toUpperCase(), note: str(c.note), source: str(c.source) }))
          : [],
        version: s.version,
      };
      if (s.brief && str(s.brief.why)) points.push({ label: "Why now", text: str(s.brief.why)! });
      if (s.lane || s.funnel_stage) points.push({ label: "Where it fits", text: [s.lane && `${s.lane} lane`, s.funnel_stage && `${({ tofu: "Top of funnel: reach", mofu: "Middle of funnel: trust", bofu: "Bottom of funnel: leads" } as Record<string, string>)[s.funnel_stage] ?? s.funnel_stage}`].filter(Boolean).join(" · ") });
      if (s.film_by) scheduledFor = null;
      if (str(p.film_by) || s.film_by) points.push({ label: "Deadline", text: str(s.brief?.deadline_label) ?? "Film by the date on the brief" });
    }
  } else if ((r.subject_type === "edit_job" || r.subject_type === "edit_render") && r.subject_id) {
    const [e] = await sql<EditForReview[]>`
      select e.id, e.ref, e.version, e.content_id, e.output_asset_id, e.notes, e.qc_report, c.title, m.width, m.height, m.duration_s::text,
             (select s.captions from scripts s where s.content_id = e.content_id order by s.version desc limit 1) as captions
        from edit_jobs e
        left join content c on c.id = e.content_id
        left join media_assets m on m.id = e.output_asset_id
       where e.id = ${r.subject_id} and e.workspace_id = ${ws.id}`;
    if (e) {
      contentId = e.content_id;
      title = e.title ?? title;
      const captions = captionsFrom(e.captions);
      platforms = captions.map((c) => c.platform).slice(0, 3);
      const notes = [...new Set(
        (Array.isArray(e.notes) ? (e.notes as unknown[]) : [])
          .filter((n) => typeof n === "string" || (typeof (n as { version?: unknown })?.version === "number" ? (n as { version: number }).version === e.version - 1 : true))
          .flatMap((n) => (typeof n === "string" ? n : str((n as Record<string, unknown>)?.text) ?? "").split(/\n+/))
          .map((n) => n.trim())
          .filter(Boolean),
      )];
      const qc = e.qc_report && typeof e.qc_report === "object" ? Object.entries(e.qc_report as Record<string, unknown>).slice(0, 4).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`) : [];
      preview = {
        type: "video",
        ref: e.ref,
        version: e.version,
        assetId: e.output_asset_id,
        src: e.output_asset_id ? `/api/media/${e.output_asset_id}` : null,
        width: e.width ?? 1080,
        height: e.height ?? 1920,
        durationS: num(e.duration_s) ?? num(p.duration_s),
        title: e.title,
        caption: captions[0] ?? null,
        notes,
        qc,
        review: await videoReview(r, e).catch((err: unknown) => {
          console.warn("[studio] video review data failed:", err instanceof Error ? err.message : err);
          return null;
        }),
      };
      const qcRep = e.qc_report as { passed?: boolean; summary?: string } | null;
      if (qcRep?.summary) points.push({ label: "Checks", text: qcRep.summary });
    }
  } else if (r.subject_type === "edit_map" && r.subject_id) {
    const [e] = await sql<{ ref: string; title: string | null; content_id: string | null }[]>`
      select e.ref, c.title, e.content_id from edit_jobs e left join content c on c.id = e.content_id where e.id = ${r.subject_id} and e.workspace_id = ${ws.id}`;
    if (e) {
      contentId = e.content_id;
      title = `${e.title ?? e.ref}: cut list`;
      const flags = Array.isArray(p.flags) ? (p.flags as unknown[]).filter((f): f is string => typeof f === "string") : [];
      preview = { type: "text", text: [r.summary.replace(/^rf-\d+ cut list:\s*/i, ""), ...flags].join(" ") };
      points.push({ label: "Why you see this", text: "Review cuts before editing is on (Edits page). Approve the cuts and the Art Director plans the edit." });
    }
  } else if (r.subject_type === "post" && r.subject_id) {
    const [po] = await sql<{
      platform: string; caption: string | null; status: string; scheduled_at: Date | null; content_id: string | null; title: string | null;
      asset_id: string | null; width: number | null; height: number | null; duration_s: string | null; brief: Record<string, unknown> | null;
    }[]>`
      select p.platform, p.caption, p.status, p.scheduled_at, p.content_id, c.title, c.brief,
             m.id as asset_id, m.width, m.height, m.duration_s::text
        from posts p
        left join content c on c.id = p.content_id
        left join lateral (
          select ma.id, ma.width, ma.height, ma.duration_s from media_assets ma
           where ma.content_id = p.content_id and ma.workspace_id = p.workspace_id and ma.kind in ('render', 'image', 'thumbnail')
           order by ma.created_at desc limit 1
        ) m on true
       where p.id = ${r.subject_id} and p.workspace_id = ${ws.id}`;
    if (po) {
      contentId = po.content_id;
      title = po.title ?? title;
      platforms = [po.platform];
      scheduledFor = po.scheduled_at?.toISOString() ?? scheduledFor;
      const { text, hashtags } = splitHashtags(po.caption ?? str(p.caption) ?? "");
      preview = {
        type: "post",
        platform: po.platform,
        title: po.title,
        caption: text,
        hashtags,
        assist: po.status === "assist",
        media: po.asset_id ? { assetId: po.asset_id, src: `/api/media/${po.asset_id}`, width: po.width ?? 1080, height: po.height ?? 1920, durationS: num(po.duration_s) } : null,
      };
      if (po.status === "assist") points.push({ label: "Why you post it", text: "This one uses trending audio, which only the app can attach. The Publisher will remind you at the time with the caption ready to paste." });
      if (po.brief && str(po.brief.why)) points.push({ label: "Why this post", text: str(po.brief.why)! });
    }
  } else if (r.subject_type === "trial_reel_batch") {
    // A day of Instagram trial reels the Chief of Staff asked to schedule: the owner should see the preview first.
    const posts = Array.isArray(p.posts) ? (p.posts as { at?: string | null; title?: string; caption?: string }[]) : [];
    platforms = ["instagram"];
    scheduledFor = posts.find((x) => x.at)?.at ?? null;
    const sample = posts.find((x) => x.caption)?.caption ?? "";
    const { text, hashtags } = splitHashtags(sample);
    preview = { type: "post", platform: "instagram", title: title, caption: text || r.summary, hashtags, assist: false, media: null };
    points.push({ label: "Trial reels", text: `Instagram trial reels only: shown to people who don't follow you yet, never on your grid. ${posts.length ? `${posts.length} posts, the first at ${posts[0]?.at ? new Date(posts[0].at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: ws.config.workspace.timezone }) : "once approved"}.` : ""} Look at every variation on Edit → Trial reels before you approve.` });
  } else if (r.subject_type === "triage_item" && r.subject_id) {
    const [t] = await sql<{ kind: string; platform: string; from_handle: string | null; text: string; draft_reply: string | null; temperature: string | null; classification: Record<string, unknown> | null }[]>`
      select kind, platform, from_handle, text, draft_reply, temperature, classification from triage_items where id = ${r.subject_id} and workspace_id = ${ws.id}`;
    if (t) {
      platforms = [t.platform];
      title = t.kind === "dm" ? `Reply to ${t.from_handle ?? "a DM"}` : `Reply to a comment from ${t.from_handle ?? "a follower"}`;
      preview = {
        type: "reply",
        platform: t.platform,
        channel: t.kind === "dm" ? "dm" : "comment",
        from: t.from_handle,
        incoming: t.text,
        draft: t.draft_reply ?? str(p.draft) ?? "",
        temperature: t.temperature,
        reason: str(t.classification?.reason),
      };
      if (str(t.classification?.reason)) points.push({ label: "Why it matters", text: `${t.temperature === "hot" ? "Hot lead. " : ""}${str(t.classification?.reason)}.` });
    }
  }

  // Fall back to the approval's own preview payload when the subject row isn't there.
  if (preview.type === "text") {
    if (str(p.draft)) preview = { type: "reply", platform: str(p.platform) ?? "instagram", channel: "dm", from: str(p.from), incoming: null, draft: str(p.draft)!, temperature: null, reason: null };
    else if (str(p.caption)) {
      const { text, hashtags } = splitHashtags(str(p.caption)!);
      preview = { type: "post", platform: str(p.platform) ?? "instagram", title: null, caption: text, hashtags, assist: false, media: null };
    } else if (str(p.hook)) preview = { type: "script", title, hook: str(p.hook), body: str(p.hook)!, beats: [], captions: [], keyword: str(p.keyword), claims: [], version: null };
  }

  // The run that produced it: its summary and the agent's own steps are the reasoning.
  let steps: ApprovalView["why"]["steps"] = [];
  if (r.run_id) {
    const [run] = await sql<{ output: Record<string, unknown> | null; job_id: string }[]>`select output, job_id from agent_runs where id = ${r.run_id} and workspace_id = ${ws.id}`;
    if (run?.output && str(run.output.summary)) points.unshift({ label: "What the agent did", text: str(run.output.summary)! });
    const ev = await sql<{ ts: Date; agent: string; message: string }[]>`
      select ts, agent, message from agent_events
       where workspace_id = ${ws.id} and run_id = ${r.run_id} and kind in ('progress', 'text', 'handoff')
       order by id asc limit 12`;
    steps = ev.map((e) => ({ ts: e.ts.toISOString(), agent: e.agent, message: e.message }));
  }

  return {
    ...baseView(r),
    title,
    scheduledFor,
    platforms,
    preview,
    why: { points, steps },
    editHref: r.subject_type === "trial_reel_batch" ? "/edit" : contentId ? `/content/${contentId}` : null,
  };
}

type EditForReview = {
  id: string; ref: string; version: number; content_id: string | null; output_asset_id: string | null; notes: unknown; qc_report: unknown; title: string | null;
  width: number | null; height: number | null; duration_s: string | null; captions: unknown;
};

/** Versions, editable captions per platform, the planned post slots, QC and earlier notes for a finished video. */
async function videoReview(r: ApprovalRow, e: EditForReview): Promise<VideoReview> {
  const ws = workspace();
  const sql = ws.sql;
  const versions = await sql<{ id: string; version: string | null; duration_s: string | null }[]>`
    select distinct on (coalesce(provenance->>'version', '1')) id, provenance->>'version' as version, duration_s::text
      from media_assets
     where workspace_id = ${ws.id} and kind = 'render'
       and (provenance->>'ref' = ${e.ref} or id = ${e.output_asset_id})
     order by coalesce(provenance->>'version', '1'), created_at desc`;
  const vlist: VideoVersion[] = versions
    .map((v) => ({ version: Number(v.version ?? (v.id === e.output_asset_id ? e.version : 1)), assetId: v.id, src: `/api/media/${v.id}`, durationS: num(v.duration_s) }))
    .sort((a, b) => a.version - b.version);
  if (e.output_asset_id && !vlist.some((v) => v.assetId === e.output_asset_id)) vlist.push({ version: e.version, assetId: e.output_asset_id, src: `/api/media/${e.output_asset_id}`, durationS: num(e.duration_s) });

  let slots: PlannedSlot[] = [];
  try {
    const [rel] = await sql<{ slots: PlannedSlot[] }[]>`select slots from production_releases where workspace_id = ${ws.id} and edit_job_id = ${e.id} and version = ${e.version}`;
    slots = rel?.slots ?? [];
  } catch {
    // production module off: no planned slots
  }
  const qcRaw = (e.qc_report ?? null) as { passed?: boolean; summary?: string; checks?: { label?: string; id?: string; status?: string; detail?: string }[] } | null;
  const checks: QcCheck[] = Array.isArray(qcRaw?.checks)
    ? qcRaw!.checks.map((c) => ({ label: c.label ?? c.id ?? "Check", status: c.status ?? "pass", detail: c.detail ?? null }))
    : [];
  const caps = captionsFrom(e.captions).map((c) => ({ platform: c.platform, text: c.hashtags.length ? `${c.text}\n\n${c.hashtags.join(" ")}` : c.text }));
  const history = (Array.isArray(e.notes) ? (e.notes as { version?: number; text?: string; at?: string }[]) : [])
    .filter((n) => typeof n?.text === "string" && n.text.trim())
    .map((n) => ({ version: n.version ?? 1, text: n.text!.trim(), at: n.at ?? null }))
    .filter((n, i, all) => all.findIndex((m) => m.text === n.text && m.version === n.version) === i);
  let instagramAutopost = false;
  const pub = (ws.config.modules.publishing?.settings ?? {}) as { instagram?: { autopost?: boolean } };
  instagramAutopost = pub.instagram?.autopost === true;
  return {
    editId: e.id,
    editRef: e.ref,
    contentId: e.content_id,
    versions: vlist,
    captions: caps,
    slots,
    qc: { passed: typeof qcRaw?.passed === "boolean" ? qcRaw.passed : null, summary: qcRaw?.summary ?? null, checks },
    history,
    publisherAutopilot: ws.config.agents.publisher?.autonomy === "autopilot",
    instagramAutopost,
    hasPublisher: ws.config.modules.publishing?.enabled !== false,
  };
}

export type RevisingVideo = { editId: string; ref: string; title: string; fromVersion: number; assetId: string | null; progress: string | null; error: string | null; notes: string | null; since: string };

/**
 * Videos sent back with notes and not back yet: shown in Approvals as "Editing v2…" until the new version lands.
 * Used by an unfinished feature (see components/UNFINISHED.md).
 */
export async function getRevisingVideos(): Promise<RevisingVideo[]> {
  const ws = workspace();
  const rows = await ws.sql<{ id: string; ref: string; title: string | null; version: number; status: string; output_asset_id: string | null; decision_note: string | null; decided_at: Date }[]>`
    select e.id, e.ref, c.title, e.version, e.status, e.output_asset_id, a.decision_note, a.decided_at
      from edit_jobs e
      left join content c on c.id = e.content_id
      join lateral (
        select status, decision_note, decided_at from approvals
         where workspace_id = e.workspace_id and subject_id = e.id and kind = 'edit' and subject_type in ('edit_render', 'edit_job')
         order by requested_at desc limit 1
      ) a on true
     where e.workspace_id = ${ws.id} and a.status = 'revised' and e.status not in ('cancelled', 'approved') and a.decided_at > now() - interval '3 days'
     order by a.decided_at desc limit 20`;
  if (!rows.length) return [];
  const runs = await ws.sql<{ ref: string; id: string; status: string; error: string | null; job_id: string }[]>`
    select distinct on (input->>'ref') input->>'ref' as ref, id, status, error, job_id from agent_runs
     where workspace_id = ${ws.id} and job_id in ('editing.revise', 'editing.render') and input->>'ref' = any(${rows.map((r) => r.ref)})
     order by input->>'ref', created_at desc`;
  const ev = await ws.sql<{ run_id: string; message: string }[]>`
    select distinct on (run_id) run_id, message from agent_events
     where workspace_id = ${ws.id} and kind = 'progress' and run_id = any(${runs.map((r) => r.id)}) order by run_id, id desc`;
  return rows.map((r) => {
    const run = runs.find((x) => x.ref === r.ref);
    const nextVersion = r.status === "review" ? r.version + 1 : r.version;
    return {
      editId: r.id,
      ref: r.ref,
      title: r.title ?? r.ref,
      fromVersion: nextVersion - 1,
      assetId: r.output_asset_id,
      progress: run && ["queued", "running"].includes(run.status) ? ev.find((x) => x.run_id === run.id)?.message ?? (run.status === "queued" ? "Waiting for the editor" : null) : null,
      error: run?.status === "failed" ? run.error : null,
      notes: r.decision_note,
      since: r.decided_at.toISOString(),
    };
  });
}

/** The workspace's own handle per platform, for the preview chrome. */
export async function getSocialHandles(): Promise<Record<string, string>> {
  const ws = workspace();
  const rows = await ws.sql<{ platform: string; handle: string }[]>`
    select distinct on (platform) platform, handle from social_accounts where workspace_id = ${ws.id} order by platform, connected_at desc`;
  return Object.fromEntries(rows.map((r) => [r.platform, r.handle.startsWith("@") ? r.handle.slice(1) : r.handle]));
}

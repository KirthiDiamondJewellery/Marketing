import type { AttentionOSConfig, Sql } from "@attentionos/core";
import { addDays, cleanHashtags, foreignTitleWords, hashtagsIn, interleave, LAYOUTS, localDate, slots, slugFor, type Layout } from "./plan.ts";
import { DAILY_CAP, trialReelsSettings } from "./settings.ts";

/**
 * SQL for trial-reel batches and their ledger, plus creating a batch (shared by the agent tool and Studio, so both
 * apply the same gates). Every query filters by workspace_id. Only needs `{ id, sql, config }`, so Studio can call it
 * without a full workspace context.
 */

export type TrialWs = { id: string; sql: Sql; config: AttentionOSConfig; now?: () => Date };

export const BATCH_STATUSES = ["queued", "rendering", "ready", "failed", "scheduling", "proving", "scheduled", "partial", "cancelled"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export type BatchSource = {
  slug: string;
  kind: "edit" | "upload";
  editRef: string | null;
  editVersion: number | null;
  assetId: string | null;
  contentId: string | null;
  /** The source's own name (content title or file name), for display. */
  name: string;
  /** The owner's title first, then light reorders of the same words. */
  titles: string[];
  captionLine: string | null;
  hashtags: string[];
  layout: Layout;
  cta: { text: string; start?: number | null } | null;
};

export type BatchVariant = {
  id: string;
  reel: string;
  index: number;
  speed: number;
  grade: string;
  captionStyle: string;
  titleStyle: string;
  ctaStyle: string;
  title: string;
  postCaption: string;
  file: string;
  sha256?: string;
  durationS?: number;
  assetId?: string | null;
  posterId?: string | null;
};

export type BatchManifest = { variants: BatchVariant[]; timings?: Record<string, number>; partial?: boolean };
export type BatchVerify = { ok: boolean; count: number; failures: string[]; files: Record<string, string | null> };

export type BatchRow = {
  id: string;
  workspace_id: string;
  ref: string;
  post_date: string;
  status: BatchStatus;
  total: number;
  sources: BatchSource[];
  manifest: BatchManifest | null;
  verify: BatchVerify | null;
  preview_asset_id: string | null;
  work_dir: string | null;
  progress: string | null;
  error: string | null;
  approval_ref: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  outcome: Record<string, unknown> | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

export type LedgerRow = {
  batch_id: string;
  variant_id: string;
  post_id: string | null;
  status: "sending" | "scheduled" | "published" | "failed" | "cancelled";
  scheduled_at: Date | null;
  caption: string | null;
  message: string | null;
};

const BATCH_COLS = (sql: Sql) => sql`id, workspace_id, ref, to_char(post_date, 'YYYY-MM-DD') as post_date, status, total, sources, manifest, verify,
  preview_asset_id, work_dir, progress, error, approval_ref, confirmed_by, confirmed_at, outcome, created_by, created_at, updated_at`;

export async function getBatch(ws: TrialWs, idOrRef: string): Promise<BatchRow | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrRef);
  const [row] = await ws.sql<BatchRow[]>`
    select ${BATCH_COLS(ws.sql)} from trial_reel_batches
     where workspace_id = ${ws.id} and ${byId ? ws.sql`id = ${idOrRef}` : ws.sql`ref = ${idOrRef.toLowerCase()}`}`;
  return row ?? null;
}

export async function recentBatches(ws: TrialWs, limit = 10): Promise<BatchRow[]> {
  return ws.sql<BatchRow[]>`
    select ${BATCH_COLS(ws.sql)} from trial_reel_batches where workspace_id = ${ws.id} order by created_at desc limit ${limit}`;
}

export type BatchPatch = Partial<{
  status: BatchStatus;
  manifest: BatchManifest | null;
  verify: BatchVerify | null;
  preview_asset_id: string | null;
  work_dir: string | null;
  progress: string | null;
  error: string | null;
  approval_ref: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  outcome: Record<string, unknown> | null;
}>;

export async function updateBatch(ws: TrialWs, id: string, patch: BatchPatch): Promise<void> {
  const cols: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols[k] = ["manifest", "verify", "outcome"].includes(k) && v !== null ? ws.sql.json(v as never) : v;
  }
  if (!Object.keys(cols).length) return;
  await ws.sql`update trial_reel_batches set ${ws.sql(cols as never)}, updated_at = now() where workspace_id = ${ws.id} and id = ${id}`;
}

export async function ledger(ws: TrialWs, batchId: string): Promise<LedgerRow[]> {
  return ws.sql<LedgerRow[]>`
    select batch_id, variant_id, post_id, status, scheduled_at, caption, message from trial_reel_posts
     where workspace_id = ${ws.id} and batch_id = ${batchId} order by scheduled_at nulls first, variant_id`;
}

/** Writes the "sending" row before the publisher call. False when the variation is already in the ledger. */
export async function claimLedger(ws: TrialWs, row: { batchId: string; variantId: string; scheduledAt: Date | null; caption: string }): Promise<boolean> {
  const rows = await ws.sql`
    insert into trial_reel_posts (workspace_id, batch_id, variant_id, status, scheduled_at, caption)
    values (${ws.id}, ${row.batchId}, ${row.variantId}, 'sending', ${row.scheduledAt}, ${row.caption})
    on conflict (batch_id, variant_id) do nothing returning variant_id`;
  return rows.length > 0;
}

export async function settleLedger(ws: TrialWs, batchId: string, variantId: string, patch: { status: LedgerRow["status"]; postId?: string | null; message?: string | null }): Promise<void> {
  await ws.sql`
    update trial_reel_posts set status = ${patch.status}, post_id = coalesce(${patch.postId ?? null}, post_id), message = ${patch.message ?? null}, updated_at = now()
     where workspace_id = ${ws.id} and batch_id = ${batchId} and variant_id = ${variantId}`;
}

// ---------------------------------------------------------------------------------------------------------------
// creating a batch
// ---------------------------------------------------------------------------------------------------------------

export type NewReel = {
  source: { kind: "edit"; editRef: string } | { kind: "upload"; assetId: string };
  /** The owner's title first, then optional light reorders of the same words. [] = no title. */
  titles: string[];
  captionLine?: string | null;
  hashtags: string[];
  layout?: Layout;
  cta?: { text: string } | null;
};

export type NewBatch = { date?: string; total?: number; reels: NewReel[]; createdBy: string };

export class BatchError extends Error {
  constructor(message: string, readonly fix?: string) {
    super(message);
    this.name = "BatchError";
  }
}

type SourceInfo = { kind: "edit" | "upload"; key: string; editRef: string | null; editVersion: number | null; assetId: string | null; contentId: string | null; name: string; keyword: string | null; ctaType: string | null };

async function resolveSource(ws: TrialWs, src: NewReel["source"]): Promise<SourceInfo> {
  if (src.kind === "edit") {
    const byId = /^[0-9a-f-]{36}$/i.test(src.editRef);
    const [e] = await ws.sql<{ ref: string; version: number; status: string; content_id: string | null; title: string | null; keyword: string | null; cta_type: string | null; has_plan: boolean }[]>`
      select e.ref, e.version, e.status, e.plan is not null as has_plan, e.content_id, c.title, k.word::text as keyword, c.cta_type
        from edit_jobs e left join content c on c.id = e.content_id and c.workspace_id = e.workspace_id
        left join keywords k on k.id = c.keyword_id and k.workspace_id = e.workspace_id
       where e.workspace_id = ${ws.id} and ${byId ? ws.sql`e.id = ${src.editRef}` : ws.sql`e.ref = ${src.editRef.toLowerCase()}`}`;
    if (!e) throw new BatchError(`There is no edit called ${src.editRef}.`);
    if (!["review", "approved"].includes(e.status)) throw new BatchError(`${e.ref} isn't finished yet.`, "Make trial reels from a finished or approved video.");
    if (!e.has_plan) throw new BatchError(`“${e.title ?? e.ref}” has no edit plan, so it can't be rendered again without captions.`, "Upload a clean version (no captions, no title) with “These are clean reels for trial reels” ticked.");
    return { kind: "edit", key: `edit:${e.ref}:v${e.version}`, editRef: e.ref, editVersion: e.version, assetId: null, contentId: e.content_id, name: e.title ?? e.ref, keyword: e.keyword, ctaType: e.cta_type };
  }
  const [a] = await ws.sql<{ id: string; kind: string; uri: string; content_id: string | null; provenance: Record<string, unknown> | null }[]>`
    select id, kind, uri, content_id, provenance from media_assets where workspace_id = ${ws.id} and id = ${src.assetId}`;
  if (!a || !["raw", "other", "render"].includes(a.kind)) throw new BatchError("That clean reel isn't in this workspace.", "Upload it again.");
  const name = typeof a.provenance?.fileName === "string" ? a.provenance.fileName : (a.uri.split("/").pop() ?? "clean reel");
  return { kind: "upload", key: `asset:${a.id}`, editRef: null, editVersion: null, assetId: a.id, contentId: a.content_id, name, keyword: null, ctaType: null };
}

/**
 * Checks the owner's inputs and saves a new batch (status "queued"). The caller queues `trial-reels.make`.
 * Gates: the day's total (1..50, at least one per reel), a date that hasn't passed, the owner's words only in titles,
 * at least 5 hashtags per reel, the comment keyword in the caption line when the video asks for a comment, and never
 * a second batch for a reel and day that already has scheduled trial reels.
 */
export async function createBatch(ws: TrialWs, input: NewBatch): Promise<BatchRow> {
  const settings = trialReelsSettings(ws.config);
  const tz = ws.config.workspace.timezone;
  const now = ws.now?.() ?? new Date();
  const today = localDate(now, tz);
  const date = input.date ?? addDays(today, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BatchError("Pick the day as YYYY-MM-DD.");
  if (date < today) throw new BatchError("That day has already passed.", "Pick today or a later day.");
  if (!input.reels.length) throw new BatchError("Pick at least one video.");
  if (input.reels.length > 10) throw new BatchError("Up to 10 videos per day.");
  const total = input.total ?? settings.dailyTotal;
  if (!Number.isInteger(total) || total < 1 || total > DAILY_CAP) throw new BatchError(`The day's total must be 1 to ${DAILY_CAP} (Instagram's daily publishing cap).`);
  if (total < input.reels.length) throw new BatchError(`${total} trial reels can't cover ${input.reels.length} videos.`, "Raise the total or pick fewer videos.");

  const sources: BatchSource[] = [];
  const taken = new Set<string>();
  const keys: string[] = [];
  for (const reel of input.reels) {
    const info = await resolveSource(ws, reel.source);
    if (keys.includes(info.key)) throw new BatchError(`“${info.name}” is in the list twice.`);
    keys.push(info.key);
    const titles = reel.titles.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (titles.some((t) => t.length > 90)) throw new BatchError("Keep titles under 90 characters.");
    for (const alt of titles.slice(1)) {
      const foreign = foreignTitleWords(titles[0]!, alt);
      if (foreign.length) throw new BatchError(`“${alt}” uses words that aren't in your title (${foreign.join(", ")}).`, "Other wordings may only reorder your own title's words.");
    }
    const hashtags = cleanHashtags(reel.hashtags);
    if (hashtags.length < 5) throw new BatchError(`“${info.name}” needs at least 5 hashtags about its topic (has ${hashtags.length}).`);
    const captionLine = reel.captionLine?.trim() || null;
    if (info.ctaType === "comment_keyword" && info.keyword && !new RegExp(`\\b${info.keyword}\\b`, "i").test(captionLine ?? "")) {
      throw new BatchError(`“${info.name}” asks for a comment, so the caption line needs the keyword ${info.keyword.toUpperCase()}.`, `Add your line, e.g. "Comment ${info.keyword.toUpperCase()} and I'll send it to you."`);
    }
    const slug = slugFor(titles[0] ?? info.name, taken);
    taken.add(slug);
    const layout = reel.layout ?? "talking-head";
    if (!(layout in LAYOUTS)) throw new BatchError(`Unknown layout ${layout}.`);
    const ctaText = reel.cta?.text?.trim();
    sources.push({
      slug, kind: info.kind, editRef: info.editRef, editVersion: info.editVersion, assetId: info.assetId, contentId: info.contentId, name: info.name,
      titles, captionLine, hashtags: hashtags.slice(0, 30), layout, cta: ctaText ? { text: ctaText.slice(0, 120) } : null,
    });
  }

  // Never render and post the same reel twice on one day.
  const busy = await ws.sql<{ ref: string; key: string }[]>`
    select b.ref, s->>'kind' || ':' || coalesce(s->>'editRef', s->>'assetId') as key
      from trial_reel_batches b, jsonb_array_elements(b.sources) s
     where b.workspace_id = ${ws.id} and b.post_date = ${date} and b.status in ('scheduling', 'proving', 'scheduled', 'partial')`;
  for (const s of sources) {
    const k = s.kind === "edit" ? `edit:${s.editRef}` : `upload:${s.assetId}`;
    const clash = busy.find((b) => b.key === k);
    if (clash) throw new BatchError(`“${s.name}” already has trial reels scheduled on ${date} (${clash.ref}).`, "Pick another day, or cancel that batch first.");
  }

  return ws.sql.begin(async (tx) => {
    const [{ n }] = (await tx`select aos_next_counter(${ws.id}, 'tr') as n`) as unknown as [{ n: string }];
    const [row] = await tx<BatchRow[]>`
      insert into trial_reel_batches (workspace_id, ref, post_date, status, total, sources, created_by)
      values (${ws.id}, ${`tr-${n}`}, ${date}, 'queued', ${total}, ${tx.json(sources as never)}, ${input.createdBy})
      returning ${BATCH_COLS(tx as unknown as Sql)}`;
    return row!;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// the posting plan (times per variation), shared by the job, the tool and Studio
// ---------------------------------------------------------------------------------------------------------------

export type PlannedPost = { variantId: string; reel: string; at: Date | null; title: string; postCaption: string; assetId: string | null; posterId: string | null };

/** The batch's variations in posting order with their times. Variations posted "now" (the proof post) keep no slot. */
export function postingPlan(batch: Pick<BatchRow, "post_date" | "manifest">, opts: { window: { start: string; end: string }; timezone: string; postedNow?: ReadonlySet<string>; count?: number }): PlannedPost[] {
  const variants = batch.manifest?.variants ?? [];
  const ordered = interleave(variants.filter((v) => !opts.postedNow?.has(v.id))).slice(0, opts.count ?? variants.length);
  const times = slots(batch.post_date, ordered.length, opts.window, opts.timezone);
  return ordered.map((v, i) => ({ variantId: v.id, reel: v.reel, at: times[i] ?? null, title: v.title, postCaption: v.postCaption, assetId: v.assetId ?? null, posterId: v.posterId ?? null }));
}

// ---------------------------------------------------------------------------------------------------------------
// what trial reels can be made from (shared by the agent tool and Studio)
// ---------------------------------------------------------------------------------------------------------------

export type TrialSource = {
  kind: "edit" | "upload";
  /** Edit ref (rf-12) or the uploaded clean reel's media asset id. */
  id: string;
  name: string;
  contentId: string | null;
  status: string;
  at: string;
  /** The owner's title as a starting point (the piece's title). */
  title: string | null;
  /** The piece's own Instagram hashtags, then the settings' hashtag sets. */
  suggestedHashtags: string[];
  /** When the video asks for a comment: the Instagram caption line that has the keyword (the owner's words). */
  suggestedCaptionLine: string | null;
  keyword: string | null;
  videoAssetId: string | null;
  coverAssetId: string | null;
  /** False for an edit without an edit plan (it can't be rendered again without captions). */
  renderable: boolean;
};

/** The purpose stored on an uploaded clean reel (media_assets.provenance.purpose). */
export const CLEAN_UPLOAD_PURPOSE = "trial-reels-clean";

function captionParts(captions: unknown): { caption: string | null; tags: string[] } {
  const ig = (captions as { instagram?: { caption?: unknown; hashtags?: unknown } } | null)?.instagram;
  const caption = typeof ig?.caption === "string" ? ig.caption : null;
  const tags = Array.isArray(ig?.hashtags) ? (ig!.hashtags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  return { caption, tags: cleanHashtags([...tags, ...hashtagsIn(caption)]) };
}

export async function trialSources(ws: TrialWs, opts: { days?: number; limit?: number } = {}): Promise<TrialSource[]> {
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 20;
  let sets: string[] = [];
  try {
    sets = Object.values(trialReelsSettings(ws.config).hashtagSets).flat();
  } catch {
    sets = [];
  }
  const edits = await ws.sql<{ ref: string; status: string; content_id: string | null; title: string | null; updated_at: Date; output_asset_id: string | null; keyword: string | null; cta_type: string | null; captions: unknown; cover_id: string | null; has_plan: boolean }[]>`
    select e.ref, e.status, e.plan is not null as has_plan, e.content_id, c.title, e.updated_at, e.output_asset_id, k.word::text as keyword, c.cta_type,
           (select s.captions from scripts s where s.workspace_id = e.workspace_id and s.content_id = e.content_id and s.status <> 'rejected'
             order by (s.status = 'approved') desc, s.version desc limit 1) as captions,
           (select t.id from media_assets t where t.workspace_id = e.workspace_id and t.kind = 'thumbnail' and t.content_id = e.content_id order by t.created_at desc limit 1) as cover_id
      from edit_jobs e
      left join content c on c.id = e.content_id and c.workspace_id = e.workspace_id
      left join keywords k on k.id = c.keyword_id and k.workspace_id = e.workspace_id
     where e.workspace_id = ${ws.id} and e.status in ('review', 'approved')
       and e.updated_at > now() - make_interval(days => ${days})
     order by (e.status = 'approved') desc, e.updated_at desc limit ${limit}`;
  const uploads = await ws.sql<{ id: string; uri: string; provenance: Record<string, unknown> | null; created_at: Date; duration_s: string | null }[]>`
    select id, uri, provenance, created_at, duration_s::text from media_assets
     where workspace_id = ${ws.id} and provenance->>'purpose' = ${CLEAN_UPLOAD_PURPOSE} and created_at > now() - make_interval(days => ${days})
     order by created_at desc limit ${limit}`;
  const out: TrialSource[] = edits.map((e) => {
    const { caption, tags } = captionParts(e.captions);
    const line = e.keyword && caption ? caption.split(/\n+/).map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, "").trim()).find((l) => new RegExp(`\\b${e.keyword}\\b`, "i").test(l)) ?? null : null;
    return {
      kind: "edit", id: e.ref, name: e.title ?? e.ref, contentId: e.content_id, status: e.status, at: e.updated_at.toISOString(), title: e.title,
      suggestedHashtags: cleanHashtags([...tags, ...sets]).slice(0, 12), suggestedCaptionLine: line, keyword: e.cta_type === "comment_keyword" ? e.keyword : null,
      videoAssetId: e.output_asset_id, coverAssetId: e.cover_id, renderable: e.has_plan,
    };
  });
  for (const u of uploads) {
    const name = typeof u.provenance?.fileName === "string" ? u.provenance.fileName : (u.uri.split("/").pop() ?? "clean reel");
    out.push({
      kind: "upload", id: u.id, name, contentId: null, status: "uploaded", at: u.created_at.toISOString(), title: null,
      suggestedHashtags: cleanHashtags(sets).slice(0, 12), suggestedCaptionLine: null, keyword: null, videoAssetId: u.id, coverAssetId: null, renderable: true,
    });
  }
  return out;
}

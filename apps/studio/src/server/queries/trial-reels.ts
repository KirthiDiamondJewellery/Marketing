import "server-only";
import { getBatch, ledger, postingPlan, recentBatches, trialSources, type BatchRow, type TrialSource } from "@attentionos/module-trial-reels/repo";
import { LAYOUTS } from "@attentionos/module-trial-reels/plan";
import { trialReelsSettings, type TrialReelsSettings } from "@attentionos/module-trial-reels/settings";
import { workspace } from "@/server/workspace";

/**
 * Trial reels in Studio: the batches (made from a finished video or an uploaded clean reel), what each variation looks
 * like and when it posts, and what was sent. Rendering, checking and scheduling happen in the worker
 * (`trial-reels.make`, `trial-reels.schedule`); Studio only shows and queues.
 */

export type TrialSettingsView = { dailyTotal: number; window: { start: string; end: string }; graduation: "manual" | "auto"; hashtagSets: Record<string, string[]>; tz: string; tomorrow: string; ackAccepted: boolean; problem: string | null };

export type TrialVariantView = { id: string; reel: string; title: string; caption: string; speed: number; grade: string; captionStyle: string; titleStyle: string; posterId: string | null; assetId: string | null; at: string | null };

export type TrialLedgerView = { variantId: string; status: string; at: string | null; postId: string | null; postStatus: string | null; url: string | null };

export type TrialBatchView = {
  id: string;
  ref: string;
  date: string;
  status: BatchRow["status"];
  total: number;
  progress: string | null;
  error: string | null;
  previewId: string | null;
  sources: { slug: string; name: string; titles: string[]; captionLine: string | null; hashtags: string[]; layout: string }[];
  variants: TrialVariantView[];
  ledger: TrialLedgerView[];
  /** True when the account's first trial reel still needs the owner's check (only one goes out until then). */
  proofNeeded: boolean;
  /** The posted proof reel waiting for the owner's check, if any. */
  proofPost: { postId: string; status: string; url: string | null } | null;
  approvalRef: string | null;
  createdAt: string;
  timings: Record<string, number> | null;
};

const tomorrowIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86_400_000));

export function trialSettingsView(): TrialSettingsView {
  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  let s: TrialReelsSettings | null = null;
  let problem: string | null = null;
  try {
    s = trialReelsSettings(ws.config);
  } catch (e) {
    problem = (e as Error).message;
  }
  return {
    dailyTotal: s?.dailyTotal ?? 9, window: s?.window ?? { start: "08:00", end: "21:00" }, graduation: s?.graduation ?? "manual", hashtagSets: s?.hashtagSets ?? {},
    tz, tomorrow: tomorrowIn(tz), ackAccepted: ws.config.acknowledgements.trialReelsRisk === true, problem,
  };
}

/**
 * True when trial reels can run: the module is on (it needs editing and publishing, so it waits for a publisher such as
 * Zernio) and its tables exist (its migration ran).
 */
export async function trialReelsReady(): Promise<boolean> {
  const ws = workspace();
  const m = ws.config.modules;
  if (m["trial-reels"]?.enabled === false || m["publishing"]?.enabled === false || m["editing"]?.enabled === false) return false;
  const [t] = await ws.sql<{ ok: boolean }[]>`select to_regclass('trial_reel_batches') is not null as ok`;
  return Boolean(t?.ok);
}

async function proofState(): Promise<{ needed: boolean }> {
  const ws = workspace();
  const rows = await ws.sql<{ proven: boolean }[]>`
    select exists (select 1 from settings s where s.workspace_id = a.workspace_id and s.key = 'publishing.trial_reels.proof:' || a.provider_account_id) as proven
      from social_accounts a where a.workspace_id = ${ws.id} and a.platform = 'instagram' and a.status = 'connected'`;
  return { needed: !rows.some((r) => r.proven) };
}

export async function trialBatchView(idOrRef: string): Promise<TrialBatchView | null> {
  const ws = workspace();
  const batch = await getBatch(ws, idOrRef);
  if (!batch) return null;
  const settings = trialSettingsView();
  const led = await ledger(ws, batch.id);
  const postIds = led.map((l) => l.post_id).filter((x): x is string => Boolean(x));
  const posts = postIds.length
    ? await ws.sql<{ id: string; status: string; url: string | null }[]>`select id, status, url from posts where workspace_id = ${ws.id} and id = any(${postIds}::uuid[])`
    : [];
  const postOf = new Map(posts.map((p) => [p.id, p]));
  const postedNow = new Set(led.filter((l) => l.scheduled_at === null).map((l) => l.variant_id));
  const plan = batch.manifest ? postingPlan(batch, { window: settings.window, timezone: settings.tz, postedNow }) : [];
  const at = new Map(plan.map((p) => [p.variantId, p.at ? p.at.toISOString() : null]));
  for (const l of led) at.set(l.variant_id, l.scheduled_at ? new Date(l.scheduled_at).toISOString() : null);
  const order = new Map([...postedNow, ...plan.map((p) => p.variantId)].map((id, i) => [id, i]));
  const variants = (batch.manifest?.variants ?? [])
    .map((v) => ({
      id: v.id, reel: v.reel, title: v.title, caption: v.postCaption, speed: v.speed, grade: v.grade, captionStyle: v.captionStyle, titleStyle: v.titleStyle,
      posterId: v.posterId ?? null, assetId: v.assetId ?? null, at: at.get(v.id) ?? null,
    }))
    .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  const proof = await proofState();
  const proofLed = led.find((l) => l.scheduled_at === null && l.post_id);
  const proofPost = proofLed ? postOf.get(proofLed.post_id!) : undefined;
  return {
    id: batch.id,
    ref: batch.ref,
    date: batch.post_date,
    status: batch.status,
    total: batch.total,
    progress: batch.progress,
    error: batch.error,
    previewId: batch.preview_asset_id,
    sources: batch.sources.map((s) => ({ slug: s.slug, name: s.name, titles: s.titles, captionLine: s.captionLine, hashtags: s.hashtags, layout: LAYOUTS[s.layout]?.label ?? s.layout })),
    variants,
    ledger: led.map((l) => ({
      variantId: l.variant_id, status: l.status, at: l.scheduled_at ? new Date(l.scheduled_at).toISOString() : null, postId: l.post_id,
      postStatus: l.post_id ? postOf.get(l.post_id)?.status ?? null : null, url: l.post_id ? postOf.get(l.post_id)?.url ?? null : null,
    })),
    proofNeeded: proof.needed,
    proofPost: proofPost ? { postId: proofPost.id, status: proofPost.status, url: proofPost.url } : null,
    approvalRef: batch.approval_ref,
    createdAt: batch.created_at.toISOString(),
    timings: (batch.manifest?.timings as Record<string, number> | undefined) ?? null,
  };
}

export type TrialSummary = {
  ready: boolean;
  batches: { id: string; ref: string; date: string; status: BatchRow["status"]; total: number; names: string[]; progress: string | null; error: string | null; previewId: string | null }[];
  cleanUploads: TrialSource[];
};

/** For the Edit page: recent batches and clean reels uploaded for trial reels. */
export async function trialSummary(): Promise<TrialSummary> {
  if (!(await trialReelsReady().catch(() => false))) return { ready: false, batches: [], cleanUploads: [] };
  const ws = workspace();
  const [rows, sources] = await Promise.all([recentBatches(ws, 6), trialSources(ws, { days: 30 })]);
  const used = new Set(rows.flatMap((b) => b.sources.map((s) => s.assetId)).filter(Boolean));
  return {
    ready: true,
    batches: rows.map((b) => ({ id: b.id, ref: b.ref, date: b.post_date, status: b.status, total: b.total, names: b.sources.map((s) => s.name), progress: b.progress, error: b.error, previewId: b.preview_asset_id })),
    cleanUploads: sources.filter((s) => s.kind === "upload" && !used.has(s.id)),
  };
}

/** Defaults for the form: the source's title, its own hashtags, the keyword line when it asks for a comment. */
export async function trialSourceDefaults(source: { kind: "edit"; editRef: string } | { kind: "upload"; assetId: string }): Promise<TrialSource | null> {
  const ws = workspace();
  const all = await trialSources(ws, { days: 120, limit: 60 });
  return all.find((s) => (source.kind === "edit" ? s.kind === "edit" && s.id === source.editRef.toLowerCase() : s.kind === "upload" && s.id === source.assetId)) ?? null;
}

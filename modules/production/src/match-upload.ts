import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { JobContext, WorkspaceContext } from "@attentionos/core";
import { recordAgentEvent } from "@attentionos/db";
import { ffprobe, findBinary } from "@attentionos/media";
import { clearWinner, rankScripts, type MatchResult, type ScriptCandidate } from "./match.ts";
import { getUpload, linkUpload, updateUpload, type UploadRow } from "./repo.ts";
import { loadProductionSettings } from "./settings.ts";

const run = promisify(execFile);

/** Scripts a take can belong to: written and not yet published, newest deadline first. */
export async function scriptCandidates(ws: Pick<WorkspaceContext, "id" | "sql">): Promise<ScriptCandidate[]> {
  const rows = await ws.sql<{ id: string; title: string; body: string | null; hook: string | null }[]>`
    select c.id, c.title, s.body, s.hook_text as hook
      from content c
      join lateral (
        select body, hook_text from scripts
         where content_id = c.id and workspace_id = c.workspace_id and status <> 'rejected'
         order by (status = 'approved') desc, version desc limit 1
      ) s on true
     where c.workspace_id = ${ws.id} and c.status in ('idea', 'scripted', 'filming', 'editing', 'review')
     order by c.film_by asc nulls last, c.updated_at desc
     limit 60`;
  return rows.filter((r) => r.body).map((r) => ({ contentId: r.id, title: r.title, body: r.body!, hook: r.hook }));
}

async function ffmpeg(args: string[], signal: AbortSignal): Promise<void> {
  const bin = findBinary("ffmpeg", "ATTENTIONOS_FFMPEG");
  if (!bin) throw new Error("ffmpeg isn't installed, so the take can't be read. Run `attentionos doctor --fix`.");
  await run(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { signal, timeout: 120_000 });
}

/**
 * `production.match-upload`: probe the take, save a cover frame, transcribe its first minute and rank the scripts.
 * A clear match is linked on its own (when autoLink is on) and its edit starts; otherwise the best guesses wait in
 * Studio for the owner to confirm. Nothing waits on this: the owner can link the take by hand at any time.
 */
export async function runMatchUpload(ctx: JobContext<{ uploadId: string }>): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const up = await getUpload(ws, ctx.input.uploadId);
  if (!up) return { skipped: "upload not found" };
  const [asset] = up.asset_id ? await ws.sql<{ uri: string }[]>`select uri from media_assets where workspace_id = ${ws.id} and id = ${up.asset_id}` : [];
  if (!asset || !existsSync(asset.uri)) {
    await updateUpload(ws, up.id, { status: "failed", error: "The uploaded file is missing. Upload it again." });
    return { uploadId: up.id, status: "failed" };
  }
  const settings = await loadProductionSettings(ws);
  const dir = join(ws.paths.media, "work", "uploads", up.id);
  mkdirSync(dir, { recursive: true });

  // Probe: a file without picture or sound can't be edited, say so now rather than after prep.
  let durationS: number | null = null;
  try {
    const probe = await ffprobe(asset.uri);
    durationS = probe.durationS;
    await ws.sql`update media_assets set duration_s = ${probe.durationS}, width = ${probe.video?.displayWidth ?? null}, height = ${probe.video?.displayHeight ?? null}
                  where workspace_id = ${ws.id} and id = ${up.asset_id}`;
    await updateUpload(ws, up.id, { duration_s: probe.durationS });
    if (!probe.video || !probe.audio) {
      const error = !probe.video ? "This file has no picture. Upload the video of the take." : "This take has no sound, so there is nothing to cut on.";
      await updateUpload(ws, up.id, { status: "failed", error });
      return { uploadId: up.id, status: "failed", error };
    }
  } catch (err) {
    const error = `Couldn't read this file as a video: ${(err as Error).message}`;
    await updateUpload(ws, up.id, { status: "failed", error });
    return { uploadId: up.id, status: "failed", error };
  }

  // Cover frame for Studio (best effort).
  const thumb = join(dir, "cover.jpg");
  try {
    await ffmpeg(["-ss", String(Math.min(1, (durationS ?? 2) / 2)), "-i", asset.uri, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", thumb], ctx.signal);
    await ws.sql`
      insert into media_assets (workspace_id, kind, uri, provenance, license)
      select ${ws.id}, 'thumbnail', ${thumb}, ${ws.sql.json({ source: "upload cover", from: up.asset_id, uploadId: up.id } as never)}, 'own footage'
       where not exists (select 1 from media_assets where workspace_id = ${ws.id} and kind = 'thumbnail' and uri = ${thumb})`;
  } catch (err) {
    ctx.log.warn("cover frame failed", { error: (err as Error).message });
  }

  if (up.status === "linked" && up.linked_by !== "auto") return { uploadId: up.id, status: "linked", note: "linked by hand before the match finished" };

  const asr = ws.providers.asr;
  if (!asr) {
    await updateUpload(ws, up.id, { status: "unmatched", error: "Speech-to-text isn't set up, so pick the script for this take." });
    return { uploadId: up.id, status: "unmatched" };
  }
  await ctx.progress(`Listening to the first minute of ${up.file_name}`);
  const head = join(dir, "head.wav");
  let transcript = "";
  try {
    await ffmpeg(["-i", asset.uri, "-t", String(settings.matchWindowS), "-vn", "-ac", "1", "-ar", "16000", head], ctx.signal);
    const t = await asr.transcribe(head, {});
    transcript = t.text.trim();
  } catch (err) {
    const error = `Couldn't transcribe the take: ${(err as Error).message}`;
    await updateUpload(ws, up.id, { status: "unmatched", error });
    return { uploadId: up.id, status: "unmatched", error };
  }

  const candidates = await scriptCandidates(ws);
  const ranked: MatchResult[] = rankScripts(transcript, candidates).slice(0, 5);
  const best = ranked[0] ?? null;
  const fresh = (await getUpload(ws, up.id)) as UploadRow;
  // The owner may have linked it while we listened: keep their choice, just record what was heard.
  if (fresh.status === "linked" && fresh.linked_by !== "auto") {
    await updateUpload(ws, up.id, { transcript, candidates: ranked });
    return { uploadId: up.id, status: "linked", best };
  }
  const winner = settings.autoLink ? clearWinner(ranked, { above: settings.autoLinkAbove, margin: settings.autoLinkMargin }) : null;
  await updateUpload(ws, up.id, { transcript, candidates: ranked, confidence: best?.score ?? null, status: best && best.score > 0 ? "suggested" : "unmatched", error: null });
  if (winner) {
    const linked = await linkUpload(ws, { uploadId: up.id, contentId: winner.contentId, actor: "auto", confidence: winner.score });
    return { uploadId: up.id, status: "linked", match: winner, ref: linked.ref, role: linked.role };
  }
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "art_director",
    kind: "progress",
    runId: ctx.runId,
    message: best && best.score > 0 ? `${up.file_name} sounds like “${best.title}” (${Math.round(best.score * 100)}%). Confirm it in Film` : `Couldn't tell which script ${up.file_name} belongs to. Pick it in Film`,
    data: { uploadId: up.id, best },
  });
  return { uploadId: up.id, status: best && best.score > 0 ? "suggested" : "unmatched", best, transcriptWords: transcript.split(/\s+/).filter(Boolean).length };
}

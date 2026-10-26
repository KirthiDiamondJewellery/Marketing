import { existsSync, mkdirSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { downloadPublicFile } from "@attentionos/core";
import type { ExternalPost, JobContext, Platform, WorkspaceContext } from "@attentionos/core";
import { enqueueRun } from "@attentionos/db";
import { ingestTranscriptInputSchema, REPLY_TO, transcriptionRequestSchema, type IngestTranscriptInput, type TranscriptionRequest } from "@attentionos/module-research";
import { z } from "zod";

/**
 * `editing.transcribe`: the research hand-off (modules/research/src/handoff.ts). Research queues a
 * TranscriptionRequest; this job fetches the media (mediaPath → mediaUrl → the scraper's downloadMedia), transcribes
 * it with word timestamps through the configured ASR provider, and queues `research.ingest-transcript` with an
 * IngestTranscriptInput (passing `then` through). Failures are replied too, so research never waits forever.
 * Transcripts of other people's videos are untrusted text; this job never sends them to an LLM.
 *
 * Also accepts the short form `{ externalPostId, localPath }` for a file that is already on disk.
 */

export const shortTranscribeInput = z.object({ externalPostId: z.string().uuid(), localPath: z.string().min(1), language: z.string().optional() });
export const transcribeInput = z.union([transcriptionRequestSchema, shortTranscribeInput]);
export type TranscribeInput = z.output<typeof transcribeInput>;

const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

function insideMedia(ws: WorkspaceContext, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(ws.paths.media, p);
  const rel = relative(ws.paths.media, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`"${p}" is outside the workspace media folder.`);
  return abs;
}

async function download(url: string, dest: string, signal: AbortSignal): Promise<string> {
  return downloadPublicFile(url, dest, { signal, maxBytes: MAX_DOWNLOAD_BYTES });
}

type Fetched = { path: string } | { unavailable: string };

async function fetchMedia(ctx: JobContext<unknown>, req: TranscriptionRequest): Promise<Fetched> {
  const { ws } = ctx;
  if (req.mediaPath) {
    const p = insideMedia(ws, req.mediaPath);
    if (existsSync(p)) return { path: p };
  }
  const destDir = insideMedia(ws, req.destDir);
  mkdirSync(destDir, { recursive: true });
  if (req.mediaUrl) {
    try {
      const ext = extname(new URL(req.mediaUrl).pathname) || ".mp4";
      return { path: await download(req.mediaUrl, join(destDir, `media${ext.length <= 5 ? ext : ".mp4"}`), ctx.signal) };
    } catch (err) {
      ctx.log.warn("media download failed", { error: (err as Error).message });
      // Do not hand a rejected URL to another downloader that lacks this network boundary.
      return { unavailable: "The media link could not be downloaded safely." };
    }
  }
  const scraper = ws.providers.scraper;
  if (scraper?.downloadMedia) {
    const [row] = await ws.sql<{ platform: Platform; platform_post_id: string; author_handle: string; url: string; published_at: Date | null }[]>`
      select platform, platform_post_id, author_handle, url, published_at from external_posts where workspace_id = ${ws.id} and id = ${req.externalPostId}`;
    if (row) {
      const post: ExternalPost = {
        platform: row.platform,
        platformPostId: row.platform_post_id,
        authorHandle: row.author_handle,
        url: row.url,
        publishedAt: (row.published_at ?? new Date(0)).toISOString(),
        ...(req.mediaUrl ? { videoUrl: req.mediaUrl } : {}),
      };
      try {
        const { localPath } = await scraper.downloadMedia(post, destDir);
        if (existsSync(localPath)) return { path: localPath };
      } catch (err) {
        return { unavailable: `The post's media couldn't be downloaded: ${(err as Error).message}` };
      }
    }
  }
  return { unavailable: "No downloadable media for this post (no file, no media link, and the scraper can't download it)." };
}

export function normaliseRequest(input: TranscribeInput): TranscriptionRequest {
  if ("kind" in input) return input;
  return transcriptionRequestSchema.parse({
    kind: "external_post",
    externalPostId: input.externalPostId,
    url: "https://invalid.example/unknown",
    mediaPath: input.localPath,
    destDir: `research/${input.externalPostId}`,
    ...(input.language ? { language: input.language } : {}),
    replyTo: REPLY_TO,
  });
}

export async function runTranscribe(ctx: JobContext<TranscribeInput>): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const req = normaliseRequest(ctx.input);
  let reply: IngestTranscriptInput;
  let mediaPath: string | undefined;
  try {
    const short = !("kind" in ctx.input) ? ctx.input.localPath : null;
    const fetched: Fetched = short ? (existsSync(isAbsolute(short) ? short : resolve(ws.paths.root, short)) ? { path: isAbsolute(short) ? short : resolve(ws.paths.root, short) } : { unavailable: `No file at ${short}.` }) : await fetchMedia(ctx, req);
    if ("unavailable" in fetched) {
      reply = { externalPostId: req.externalPostId, transcript: null, error: { kind: "unavailable", message: fetched.unavailable }, ...(req.then ? { then: req.then } : {}) };
    } else {
      mediaPath = fetched.path;
      const asr = ws.providers.asr;
      if (!asr) throw new Error("Speech-to-text isn't set up. Run `attentionos doctor --fix`.");
      await ctx.progress("Transcribing a post for research");
      const t = await asr.transcribe(fetched.path, req.language ? { language: req.language } : {});
      reply = {
        externalPostId: req.externalPostId,
        transcript: { text: t.text, language: t.language, durationS: t.durationS, words: t.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) },
        mediaPath: relative(ws.paths.media, fetched.path).startsWith("..") ? fetched.path : relative(ws.paths.media, fetched.path),
        ...(req.then ? { then: req.then } : {}),
      };
    }
  } catch (err) {
    reply = {
      externalPostId: req.externalPostId,
      transcript: null,
      error: { kind: "failed", message: (err as Error).message ?? String(err) },
      ...(mediaPath ? { mediaPath } : {}),
      ...(req.then ? { then: req.then } : {}),
    };
  }
  const input = ingestTranscriptInputSchema.parse(reply);
  const run = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: req.replyTo.jobId,
    agent: req.replyTo.agent,
    input: input as unknown as Record<string, unknown>,
    trigger: "handoff",
    parentRunId: ctx.runId,
    createdBy: "agent:art_director",
    dedupeKey: `transcribed:external_post:${req.externalPostId}:${ctx.runId}`,
  });
  return { externalPostId: req.externalPostId, ok: !input.error, words: input.transcript?.words?.length ?? 0, durationS: input.transcript?.durationS, error: input.error?.message, replyRunId: run.id };
}

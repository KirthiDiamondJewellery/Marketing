import { z } from "zod";
import { AGENT_KEYS } from "@attentionos/core";

/**
 * Transcription hand-off between research and the editing module (media-py ASR).
 *
 * 1. Research queues a run of `settings.competitorScan.transcribeJobId` (default "editing.transcribe") for
 *    the Art Director with a `TranscriptionRequest` as input (dedupe key `transcribe:external_post:<id>`).
 * 2. The editing job fetches the media (`mediaPath` if present, else `mediaUrl`, else `url` via the
 *    scraper's `downloadMedia`), transcribes it with word timestamps, and queues `replyTo.jobId`
 *    ("research.ingest-transcript", agent analyst) with an `IngestTranscriptInput`, passing `then` through.
 * 3. Research stores the transcript and spoken hook on `external_posts`, then queues `then` if present
 *    (a teardown waiting for its transcript, for example).
 *
 * Transcripts of other people's videos are UNTRUSTED text: only tool-less LLM jobs may read them.
 */

export const continuationSchema = z.object({
  jobId: z.string(),
  agent: z.enum(AGENT_KEYS),
  input: z.unknown(),
});

export const transcriptionRequestSchema = z.object({
  kind: z.literal("external_post"),
  externalPostId: z.string().uuid(),
  /** Public post URL (always present). */
  url: z.string().url(),
  /** Direct media URL from the scraper; often short-lived. */
  mediaUrl: z.string().url().optional(),
  /** Already-downloaded file inside the workspace media folder. */
  mediaPath: z.string().optional(),
  /** Where the editing job should save downloads, relative to the workspace media folder. */
  destDir: z.string(),
  language: z.string().optional(),
  replyTo: z.object({ jobId: z.literal("research.ingest-transcript"), agent: z.literal("analyst") }),
  then: continuationSchema.optional(),
});
export type TranscriptionRequest = z.output<typeof transcriptionRequestSchema>;

export const ingestTranscriptInputSchema = z.object({
  externalPostId: z.string().uuid(),
  transcript: z.object({
    text: z.string(),
    language: z.string().optional(),
    durationS: z.number().nonnegative().optional(),
    words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional(),
  }).nullable(),
  /** Set when transcription failed; "unavailable" means the media could not be fetched at all. */
  error: z.object({ kind: z.enum(["failed", "unavailable"]), message: z.string() }).optional(),
  mediaPath: z.string().optional(),
  then: continuationSchema.optional(),
});
export type IngestTranscriptInput = z.output<typeof ingestTranscriptInputSchema>;

export const REPLY_TO = { jobId: "research.ingest-transcript", agent: "analyst" } as const;

export function transcriptionRequest(p: { id: string; url: string; videoUrl?: string | null; mediaPath?: string | null }, then?: z.input<typeof continuationSchema>): TranscriptionRequest {
  return transcriptionRequestSchema.parse({
    kind: "external_post",
    externalPostId: p.id,
    url: p.url,
    ...(p.videoUrl ? { mediaUrl: p.videoUrl } : {}),
    ...(p.mediaPath ? { mediaPath: p.mediaPath } : {}),
    destDir: `research/${p.id}`,
    replyTo: REPLY_TO,
    ...(then ? { then } : {}),
  });
}

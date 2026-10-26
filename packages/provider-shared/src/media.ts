import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { ProviderError } from "@attentionos/core";
import { findBinary } from "@attentionos/media";
import type { FetchLike } from "./http-client.ts";

const run = promisify(execFile);

export type VideoProbe = { videoCodec?: string; audioCodec?: string };
export type ProbeFn = (localPath: string) => Promise<VideoProbe | undefined>;

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
};

export function mimeFor(path: string, given?: string): string {
  return given ?? MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXT.has(extname(path).toLowerCase());
}

/**
 * ffprobe codec names for the first video and audio stream. Uses $ATTENTIONOS_FFPROBE when set, else ffprobe on PATH.
 * Returns undefined when ffprobe isn't installed.
 */
export const ffprobe: ProbeFn = async (localPath) => {
  const bin = findBinary("ffprobe", "ATTENTIONOS_FFPROBE");
  if (!bin) return undefined;
  const codec = async (stream: "v:0" | "a:0") => {
    const { stdout } = await run(bin, ["-v", "error", "-select_streams", stream, "-show_entries", "stream=codec_name", "-of", "csv=p=0", localPath], { timeout: 30_000 });
    return stdout.trim() || undefined;
  };
  try {
    return { videoCodec: await codec("v:0"), audioCodec: await codec("a:0") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProviderError("media", "invalid_request", `couldn't read ${basename(localPath)} with ffprobe: ${(err as Error).message}`);
  }
};

/**
 * Most platforms behind these APIs only take H.264 video with AAC audio (or no audio). X rejects VP9, which is common
 * in reels downloaded from Instagram, and vendors only auto-convert short clips. Fail early with a plain fix.
 */
export async function assertH264Aac(provider: string, localPath: string, probe: ProbeFn): Promise<"ok" | "unchecked"> {
  if (!isVideoPath(localPath)) return "ok";
  const info = await probe(localPath);
  if (!info) return "unchecked";
  if (!info.videoCodec) throw new ProviderError(provider, "invalid_request", `${basename(localPath)} has no video stream`);
  const videoOk = info.videoCodec === "h264";
  const audioOk = info.audioCodec === undefined || info.audioCodec === "aac";
  if (!videoOk || !audioOk) {
    throw new ProviderError(
      provider,
      "invalid_request",
      `${basename(localPath)} is ${info.videoCodec}/${info.audioCodec ?? "no audio"}; convert it to H.264 video with AAC audio (MP4, yuv420p, +faststart) before uploading`,
    );
  }
  return "ok";
}

/**
 * Streams a local file to a presigned URL with PUT. Large files need a long timeout (default 10 minutes).
 * The presigned URL is a credential: it is never logged or returned.
 */
export async function putFile(args: {
  provider: string;
  uploadUrl: string;
  localPath: string;
  contentType: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const { size } = await stat(args.localPath);
  const doFetch = args.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(args.uploadUrl, {
      method: "PUT",
      headers: { "content-type": args.contentType, "content-length": String(size) },
      body: createReadStream(args.localPath) as unknown as RequestInit["body"],
      // Required by Node's fetch for streamed request bodies.
      duplex: "half",
      signal: AbortSignal.timeout(args.timeoutMs ?? 600_000),
    } as RequestInit);
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    throw new ProviderError(
      args.provider,
      "upstream",
      timedOut
        ? `uploading ${basename(args.localPath)} timed out; get a fresh upload link and try again (don't post with a half-uploaded file)`
        : `uploading ${basename(args.localPath)} failed: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new ProviderError(args.provider, res.status >= 500 ? "upstream" : "invalid_request", `upload of ${basename(args.localPath)} was refused (HTTP ${res.status})`, { status: res.status });
  }
}

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import {
  ProviderError,
  type AttentionOSConfig, type ExternalPost, type Logger, type Platform, type ProviderHealth, type Scraper,
} from "@attentionos/core";

/**
 * Scraper that shells out to `yt-dlp` (https://github.com/yt-dlp/yt-dlp) for TikTok and YouTube Shorts
 * metadata, and downloads any post's video for transcription and teardowns. Free; no account needed.
 *
 * Metadata: `yt-dlp -j --skip-download --playlist-end N <profile url>` prints one JSON object per video.
 * Download:  `yt-dlp -f <mp4> -o <dest>/%(id)s.%(ext)s --print after_move:filepath <post url>`.
 *
 * Optional secret YTDLP_PATH points at a specific binary.
 */

export const PROVIDER_ID = "ytdlp";

export const INSTALL_FIX = "Install yt-dlp: `brew install yt-dlp` (macOS), `uv tool install yt-dlp` or `pipx install yt-dlp` (any OS), then run `attentionos doctor` again";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecFn = (bin: string, args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

/** Spawns without a shell (arguments are never interpolated into a command line). */
export const defaultExec: ExecFn = (bin, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

const count = z.number().nonnegative().optional().nullable().catch(undefined);

export const ytdlpEntrySchema = z.object({
  id: z.string(),
  title: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  webpage_url: z.string().optional().nullable(),
  original_url: z.string().optional().nullable(),
  timestamp: z.number().optional().nullable(),
  upload_date: z.string().regex(/^\d{8}$/).optional().nullable().catch(undefined),
  duration: count,
  view_count: count,
  like_count: count,
  comment_count: count,
  repost_count: count,
  uploader: z.string().optional().nullable(),
  uploader_id: z.string().optional().nullable(),
  channel: z.string().optional().nullable(),
  thumbnail: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
}).passthrough();

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export function entryToExternalPost(raw: unknown, platform: Platform, handle: string): ExternalPost | null {
  const r = ytdlpEntrySchema.safeParse(raw);
  if (!r.success) return null;
  const e = r.data;
  const url = e.webpage_url ?? e.original_url;
  let publishedAt: string | undefined;
  if (typeof e.timestamp === "number") publishedAt = new Date(e.timestamp * 1000).toISOString();
  else if (e.upload_date) publishedAt = `${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}T00:00:00.000Z`;
  if (!url || !publishedAt) return null;
  const caption = platform === "youtube" ? [e.title, e.description].filter(Boolean).join("\n\n") : (e.description ?? e.title ?? undefined);
  const post: ExternalPost = {
    platform,
    platformPostId: e.id,
    authorHandle: handle.replace(/^@/, ""),
    url,
    publishedAt,
    ...(caption ? { caption } : {}),
    ...(opt(e.duration) !== undefined ? { durationS: e.duration! } : {}),
    ...(opt(e.view_count) !== undefined ? { views: e.view_count! } : {}),
    ...(opt(e.like_count) !== undefined ? { likes: e.like_count! } : {}),
    ...(opt(e.comment_count) !== undefined ? { comments: e.comment_count! } : {}),
    ...(opt(e.repost_count) !== undefined ? { shares: e.repost_count! } : {}),
    ...(e.thumbnail ? { thumbnailUrl: e.thumbnail } : {}),
  };
  return post;
}

/** Parses `yt-dlp -j` output: one JSON object per line; junk lines are skipped. */
export function parseJsonLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial line from a killed process
    }
  }
  return out;
}

export function profileUrl(handle: string, platform: Platform): string {
  const h = handle.replace(/^@/, "");
  if (platform === "tiktok") return `https://www.tiktok.com/@${h}`;
  if (platform === "youtube") return `https://www.youtube.com/@${h}/shorts`;
  throw new ProviderError(PROVIDER_ID, "unsupported", `yt-dlp profile listing is only set up for TikTok and YouTube, not ${platform}`);
}

type Opts = { secret(name: string): string | undefined; config: AttentionOSConfig; log: Logger; exec?: ExecFn };

export function create(opts: Opts): Required<Pick<Scraper, "downloadMedia">> & Scraper {
  const exec = opts.exec ?? defaultExec;
  const bin = opts.secret("YTDLP_PATH") ?? "yt-dlp";
  const log = opts.log.child({ provider: PROVIDER_ID });

  async function run(args: string[], timeoutMs: number): Promise<ExecResult> {
    try {
      return await exec(bin, args, { timeoutMs });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProviderError(PROVIDER_ID, "unsupported", `yt-dlp is not installed or not on PATH. ${INSTALL_FIX}`);
      }
      throw new ProviderError(PROVIDER_ID, "upstream", `yt-dlp failed to start: ${(err as Error).message}`);
    }
  }

  const stderrError = (stderr: string): ProviderError => {
    const line = stderr.split("\n").find((l) => l.startsWith("ERROR")) ?? stderr.trim().split("\n").pop() ?? "unknown error";
    const code = /HTTP Error 429|rate.?limit/i.test(line) ? "rate_limited"
      : /HTTP Error 404|does not exist|Unable to find|not found/i.test(line) ? "not_found"
      : /login|cookies|private/i.test(line) ? "auth"
      : "upstream";
    return new ProviderError(PROVIDER_ID, code, line.replace(/^ERROR:\s*/, ""));
  };

  return {
    id: PROVIDER_ID,

    async health(): Promise<ProviderHealth> {
      try {
        const r = await run(["--version"], 15_000);
        if (r.code !== 0) return { ok: false, detail: "yt-dlp is installed but did not run", fix: INSTALL_FIX };
        return { ok: true, detail: `yt-dlp ${r.stdout.trim()} is installed` };
      } catch {
        return { ok: false, detail: "yt-dlp is not installed", fix: INSTALL_FIX };
      }
    },

    async estimateCostUsd() {
      return 0;
    },

    async listCreatorPosts(handle, platform, o) {
      const url = profileUrl(handle, platform);
      const limit = o?.limit ?? 12;
      const args = ["-j", "--skip-download", "--no-warnings", "--ignore-errors", "--playlist-end", String(limit)];
      if (o?.since) args.push("--dateafter", o.since.slice(0, 10).replaceAll("-", ""));
      args.push(url);
      const r = await run(args, 180_000);
      const entries = parseJsonLines(r.stdout);
      // --ignore-errors keeps going past single bad videos; only fail when nothing came back.
      if (entries.length === 0 && r.code !== 0) throw stderrError(r.stderr);
      const posts = entries.map((e) => entryToExternalPost(e, platform, handle)).filter((p): p is ExternalPost => p !== null);
      log.debug("yt-dlp listed posts", { platform, count: posts.length });
      return posts
        .filter((p) => !o?.since || p.publishedAt >= o.since)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    },

    async downloadMedia(post, destDir) {
      mkdirSync(destDir, { recursive: true });
      const r = await run([
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format", "mp4",
        "--no-progress", "--no-warnings", "--no-playlist",
        "-o", `${destDir.replace(/\/+$/, "")}/%(id)s.%(ext)s`,
        "--print", "after_move:filepath",
        post.url,
      ], 600_000);
      if (r.code !== 0) throw stderrError(r.stderr);
      const localPath = r.stdout.trim().split("\n").filter(Boolean).pop();
      if (!localPath) throw new ProviderError(PROVIDER_ID, "upstream", "yt-dlp finished but reported no file");
      return { localPath };
    },
  };
}

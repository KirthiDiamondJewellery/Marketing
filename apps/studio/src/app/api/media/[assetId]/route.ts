import { requireSession } from "@/server/auth";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { workspace } from "@/server/workspace";

/**
 * Streams a media asset (renders, covers, raw takes) from the workspace. Only files inside the workspace root are
 * served, symlinks are resolved before the check, and Range requests are honoured so <video> can seek.
 */
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(message = "Not found") {
  return new Response(message, { status: 404, headers: { "cache-control": "no-store" } });
}

async function insideRoot(root: string, uri: string): Promise<string | null> {
  const realRoot = await realpath(root);
  const candidate = isAbsolute(uri) ? uri : resolve(realRoot, uri);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return null;
  }
  const rel = relative(realRoot, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return null;
  return real;
}

export async function GET(req: Request, ctx: { params: Promise<{ assetId: string }> }) {
  await requireSession();
  const { assetId } = await ctx.params;
  if (!UUID.test(assetId)) return notFound();
  const ws = workspace();
  const [asset] = await ws.sql<{ uri: string }[]>`select uri from media_assets where workspace_id = ${ws.id} and id = ${assetId}`;
  if (!asset || /^[a-z]+:\/\//i.test(asset.uri)) return notFound();

  const path = await insideRoot(ws.root, asset.uri);
  if (!path) return notFound("This file isn't in the workspace media folder.");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return notFound();

  const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const size = info.size;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=60",
    "last-modified": info.mtime.toUTCString(),
    "x-content-type-options": "nosniff",
  };
  // ?download=1 saves the file instead of playing it ("Download" on a finished video), with an optional friendly name.
  const url = new URL(req.url);
  if (url.searchParams.get("download") === "1") {
    const base = (url.searchParams.get("name") ?? "").replace(/[^\w .-]+/g, "").trim().slice(0, 80) || assetId;
    const ext = extname(path).toLowerCase();
    headers["content-disposition"] = `attachment; filename="${base.endsWith(ext) ? base : base + ext}"`;
  }

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    start = Math.max(0, start);
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }

  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, "content-length": String(size) } });
}

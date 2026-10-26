import { requireSession } from "@/server/auth";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nextRef } from "@attentionos/core";
import { enqueueRun, recordAgentEvent } from "@attentionos/db";
import { insertUpload, kickAdvance, linkUpload } from "@attentionos/module-production/repo";
import { CLEAN_UPLOAD_PURPOSE } from "@attentionos/module-trial-reels/repo";
import { productionOn } from "@/server/queries/production";
import { workspace } from "@/server/workspace";

/**
 * Upload takes into `<workspace>/media/raw/`, many at once and resumable:
 *
 *   POST ?step=start   {name, size, lastModified, contentId?, purpose?}  → {uploadId, offset}   (offset > 0: resume there)
 *   PUT  ?id=…&offset=N  <raw bytes>                             → {offset}             (409 + {offset} if out of step)
 *   GET  ?id=…                                                   → {offset}
 *   POST ?step=finish&id=…                                       → {upload, ref?, message}
 *
 * The id is derived from the file's name, size and modified time, so a retry after a dropped connection (or a page
 * reload) continues where it stopped. Chunks stream straight to disk. On finish the take is filed as a raw asset;
 * with the production module on it is matched to its script (`production.match-upload`) or, when the upload came
 * from a script's own button, linked to it at once and its edit starts. With `purpose: "trial"` the file is a clean
 * reel (no captions, no title) kept for trial reels: it is filed as a raw asset and does not go to the editor.
 * A single-shot POST with `x-file-name` (and optional `x-content-id`) still works for small files.
 */
export const dynamic = "force-dynamic";

const VIDEO = new Set([".mov", ".mp4", ".m4v", ".webm", ".mkv"]);
const MAX_BYTES = 8 * 1024 ** 3;
const MAX_CHUNK = 64 * 1024 ** 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{24}$/;
const ACTOR = "user:studio" as const;

const bad = (message: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ ok: false, message, ...extra }, { status });

type Meta = { name: string; size: number; contentId: string | null; startedAt: string; purpose?: "edit" | "trial" };

function safeName(name: string): { base: string; ext: string } {
  const ext = extname(name).toLowerCase();
  const base =
    name
      .slice(0, name.length - ext.length)
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "take";
  return { base, ext };
}

function dirs() {
  const ws = workspace();
  const raw = join(ws.root, "media", "raw");
  return { ws, raw, incoming: join(raw, ".incoming") };
}

const partOf = (incoming: string, key: string) => ({ part: join(incoming, `${key}.part`), meta: join(incoming, `${key}.json`) });

async function sizeOf(path: string): Promise<number> {
  return (await stat(path).catch(() => null))?.size ?? 0;
}

async function readMeta(path: string): Promise<Meta | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Meta;
  } catch {
    return null;
  }
}

async function contentExists(contentId: string): Promise<{ id: string; title: string; template: string | null } | null> {
  const ws = workspace();
  const [c] = await ws.sql<{ id: string; title: string; template: string | null }[]>`select id, title, template from content where workspace_id = ${ws.id} and id = ${contentId}`;
  return c ?? null;
}

// ───────────────────────────── chunked protocol ─────────────────────────────

export async function GET(req: Request) {
  await requireSession();
  const key = new URL(req.url).searchParams.get("id") ?? "";
  if (!KEY.test(key)) return bad("Unknown upload.", 404);
  const { incoming } = dirs();
  const { part, meta } = partOf(incoming, key);
  const m = await readMeta(meta);
  if (!m) return bad("Unknown upload.", 404);
  return Response.json({ ok: true, uploadId: key, offset: await sizeOf(part), size: m.size });
}

export async function PUT(req: Request) {
  await requireSession();
  const params = new URL(req.url).searchParams;
  const key = params.get("id") ?? "";
  const offset = Number(params.get("offset") ?? "-1");
  if (!KEY.test(key) || !Number.isInteger(offset) || offset < 0) return bad("Unknown upload.", 404);
  const { incoming } = dirs();
  const { part, meta } = partOf(incoming, key);
  const m = await readMeta(meta);
  if (!m) return bad("Unknown upload. Start it again.", 404);
  const have = await sizeOf(part);
  if (have !== offset) return bad("Out of step; continue from the offset given.", 409, { offset: have });
  if (!req.body) return bad("Empty chunk.");
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > MAX_CHUNK || offset + seen > m.size) cb(new Error("too large"));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as never), limit, createWriteStream(part, { flags: "a" }));
  } catch (err) {
    const now = await sizeOf(part);
    return bad((err as Error).message === "too large" ? "That chunk is larger than the file." : "The connection dropped. It will resume.", 400, { offset: now });
  }
  return Response.json({ ok: true, offset: await sizeOf(part) });
}

export async function POST(req: Request) {
  await requireSession();
  const params = new URL(req.url).searchParams;
  const step = params.get("step");
  if (step === "start") return start(req);
  if (step === "finish") return finish(params.get("id") ?? "");
  return singleShot(req);
}

async function start(req: Request) {
  let body: { name?: unknown; size?: unknown; lastModified?: unknown; contentId?: unknown; purpose?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("Send the file's name and size.");
  }
  const name = typeof body.name === "string" ? body.name.slice(0, 300) : "";
  const size = Number(body.size);
  const contentId = typeof body.contentId === "string" && body.contentId ? body.contentId : null;
  const purpose = body.purpose === "trial" ? "trial" : "edit";
  if (!name) return bad("Pick a video file to upload.");
  if (!VIDEO.has(safeName(name).ext)) return bad(`${name} isn't a video file. Phone recordings (.mov, .mp4) work.`, 415);
  if (!Number.isFinite(size) || size <= 0) return bad(`${name} is empty.`);
  if (size > MAX_BYTES) return bad(`${name} is over 8 GB. Export a shorter take or a smaller file.`, 413);
  if (contentId && (!UUID.test(contentId) || !(await contentExists(contentId)))) return bad("That script doesn't exist.");
  const { ws, incoming } = dirs();
  await mkdir(incoming, { recursive: true });
  const key = createHash("sha256").update(`${ws.id}|${name}|${size}|${String(body.lastModified ?? "")}`).digest("hex").slice(0, 24);
  const { part, meta } = partOf(incoming, key);
  const existing = await readMeta(meta);
  if (!existing || existing.size !== size) {
    await rm(part, { force: true });
    await writeFile(meta, JSON.stringify({ name, size, contentId, startedAt: new Date().toISOString(), purpose } satisfies Meta));
  } else if (contentId !== existing.contentId || purpose !== (existing.purpose ?? "edit")) {
    await writeFile(meta, JSON.stringify({ ...existing, contentId, purpose }));
  }
  return Response.json({ ok: true, uploadId: key, offset: await sizeOf(part), size });
}

async function finish(key: string) {
  if (!KEY.test(key)) return bad("Unknown upload.", 404);
  const { raw, incoming } = dirs();
  const { part, meta } = partOf(incoming, key);
  const m = await readMeta(meta);
  if (!m) return bad("Unknown upload.", 404);
  const have = await sizeOf(part);
  if (have !== m.size) return bad(`Only ${have} of ${m.size} bytes arrived. It will resume.`, 409, { offset: have });
  const { base, ext } = safeName(m.name);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const finalPath = join(raw, `${base}-${stamp}${ext}`);
  await rename(part, finalPath);
  await rm(meta, { force: true });
  if (m.purpose === "trial") return Response.json(await fileCleanReel(finalPath, m.name, m.size));
  return Response.json(await fileTake(finalPath, m.name, m.size, m.contentId));
}

// ───────────────────────────── single shot (small files, older callers) ─────────────────────────────

async function singleShot(req: Request) {
  const rawName = decodeURIComponent(req.headers.get("x-file-name") ?? "");
  const contentId = req.headers.get("x-content-id") || null;
  if (!rawName) return bad("Pick a video file to upload.");
  const { base, ext } = safeName(rawName);
  if (!VIDEO.has(ext)) return bad("That isn't a video file. Phone recordings (.mov, .mp4) work.");
  if (contentId && (!UUID.test(contentId) || !(await contentExists(contentId)))) return bad("That content item doesn't exist.");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return bad("That file is over 8 GB. Export a shorter take or a smaller file.", 413);
  if (!req.body) return bad("The upload was empty.");
  const { raw } = dirs();
  await mkdir(raw, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const finalPath = join(raw, `${base}-${stamp}${ext}`);
  const tmpPath = `${finalPath}.part`;
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > MAX_BYTES) cb(new Error("too large"));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as never), limit, createWriteStream(tmpPath, { flags: "wx" }));
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    return bad((err as Error).message === "too large" ? "That file is over 8 GB." : "The upload stopped part way. Try again.", 400);
  }
  const size = await sizeOf(finalPath);
  if (size === 0) {
    await rm(finalPath, { force: true });
    return bad("The upload was empty.");
  }
  return Response.json(await fileTake(finalPath, rawName, size, contentId));
}

// ───────────────────────────── filing a clean reel for trial reels ─────────────────────────────

async function fileCleanReel(path: string, name: string, size: number) {
  const ws = workspace();
  const [asset] = await ws.sql<{ id: string }[]>`
    insert into media_assets (workspace_id, content_id, kind, uri, bytes, provenance, license)
    values (${ws.id}, null, 'raw', ${path}, ${size},
            ${ws.sql.json({ source: "own footage", addedBy: ACTOR, fileName: name, purpose: CLEAN_UPLOAD_PURPOSE } as never)}, 'own footage')
    returning id`;
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "publisher",
    kind: "progress",
    message: `Got ${name} as a clean reel for trial reels`,
    data: { by: ACTOR, assetId: asset!.id, kind: "trial-reels.clean-upload" },
  });
  return { ok: true, trialAssetId: asset!.id, message: `Uploaded ${name}. It's ready for trial reels.` };
}

// ───────────────────────────── filing the take ─────────────────────────────

async function fileTake(path: string, name: string, size: number, contentId: string | null) {
  const ws = workspace();
  const mb = (size / 1024 ** 2).toFixed(size > 100 * 1024 ** 2 ? 0 : 1);
  const [asset] = await ws.sql<{ id: string }[]>`
    insert into media_assets (workspace_id, content_id, kind, uri, bytes, provenance, license)
    values (${ws.id}, ${contentId}, 'raw', ${path}, ${size}, ${ws.sql.json({ source: "own footage", addedBy: ACTOR, fileName: name } as never)}, 'own footage')
    returning id`;

  if (await productionOn()) {
    const up = await insertUpload(ws, { assetId: asset!.id, fileName: name, bytes: size, createdBy: ACTOR });
    let linked: Awaited<ReturnType<typeof linkUpload>> | null = null;
    if (contentId) linked = await linkUpload(ws, { uploadId: up.id, contentId, actor: ACTOR }).catch((e: unknown) => {
      console.error("[studio] link on upload failed:", e);
      return null;
    });
    // Matching runs even when linked (cover frame, a check that the take sounds like its script). You started it, so
    // it runs ahead of background work (queue priority).
    await enqueueRun(ws.sql, {
      workspaceId: ws.id,
      jobId: "production.match-upload",
      agent: "art_director",
      input: { uploadId: up.id },
      trigger: "event",
      createdBy: ACTOR,
      dedupeKey: `production:match:${up.id}`,
    });
    await kickAdvance(ws, 5);
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id,
      agent: "art_director",
      kind: "progress",
      message: linked ? `Got your take for “${linked.title}” (${mb} MB). ${linked.role === "edit" ? `Editing it as ${linked.ref}` : "Kept as another take"}` : `Got ${name} (${mb} MB). Listening for which script it is`,
      data: { by: ACTOR, uploadId: up.id, assetId: asset!.id, ref: linked?.ref ?? null },
    });
    return { ok: true, upload: { id: up.id, assetId: asset!.id, fileName: name, status: linked ? "linked" : "matching", ref: linked?.ref ?? null, role: linked?.role ?? null, contentId: linked?.contentId ?? null }, ref: linked?.ref ?? null, contentId: linked?.contentId ?? contentId, message: linked ? linked.message : `Uploaded ${name}. Finding its script…` };
  }

  // Without the production module: open an edit straight away, as before.
  let content: { id: string; title: string; template: string | null } | null = null;
  if (contentId) content = await contentExists(contentId);
  const format = content?.template ?? "raw-talking-head";
  const ref = await ws.sql.begin(async (tx) => {
    const r = await nextRef(tx as never, ws.id, "rf");
    await tx`
      insert into edit_jobs (workspace_id, content_id, ref, engine, format, version, status, source_asset_id, preflight)
      values (${ws.id}, ${content?.id ?? null}, ${r}, 'cut', ${format}, 1, 'queued', ${asset!.id}, ${tx.json({ signoffs: [] } as never)})`;
    if (content) {
      await tx`update content set status = 'editing', template = coalesce(template, ${format}), updated_at = now()
                where workspace_id = ${ws.id} and id = ${content.id} and status in ('idea', 'scripted', 'filming')`;
    }
    return r;
  });
  await enqueueRun(ws.sql, { workspaceId: ws.id, jobId: "editing.prep", agent: "art_director", input: { ref }, trigger: "manual", createdBy: ACTOR, dedupeKey: `editing:${ref}:prep` });
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "art_director",
    kind: "progress",
    message: `Got your footage${content ? ` for “${content.title}”` : ""} (${mb} MB). Prepping ${ref}: transcript and a cut list next`,
    data: { by: ACTOR, ref, assetId: asset!.id },
  });
  return { ok: true, ref, contentId: content?.id ?? null, message: `Uploaded. The Art Director is prepping ${ref}.` };
}


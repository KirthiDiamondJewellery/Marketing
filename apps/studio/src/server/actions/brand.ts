"use server";

import { requireSession } from "@/server/auth";
import { z } from "zod";
import { BAD_REQUEST, parse } from "@/server/validate";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { BrandKitError, loadBrandKit } from "@attentionos/core";
import { recordAgentEvent } from "@attentionos/db";
import { revalidatePath } from "next/cache";
import { brandDir, contentHash, EDITABLE_FILES } from "@/server/queries/brand";
import { workspace } from "@/server/workspace";

export type SaveBrandResult = { ok: true; hash: string; savedAt: string; message: string } | { ok: false; error: string; conflict?: boolean };

const ACTOR = "user:studio";
const MAX_BYTES = 512 * 1024;

/** `content` has no cap here so an oversized file gets the friendlier size message below. */
const saveInput = z.object({ file: z.string().max(200), content: z.string(), baseHash: z.string().max(128) });

/** Resolves a Brand Kit file to an absolute path, refusing anything outside `<workspace>/brand/`. */
function resolveBrandPath(file: string): string | null {
  if (!EDITABLE_FILES.includes(file)) return null;
  const dir = resolve(brandDir());
  const abs = resolve(dir, file);
  const rel = relative(dir, abs);
  if (!rel || rel.startsWith("..") || rel.includes(sep) || resolve(dir, rel) !== abs) return null;
  return abs;
}

/** Plain-language reason a YAML file can't be saved, or null when the whole Brand Kit still loads. */
function validateYaml(file: string, content: string): string | null {
  const dir = brandDir();
  const tmp = mkdtempSync(join(tmpdir(), "aos-brandkit-"));
  try {
    for (const f of readdirSync(dir)) {
      if (/\.ya?ml$/.test(f)) copyFileSync(join(dir, f), join(tmp, f));
    }
    writeFileSync(join(tmp, file), content);
    loadBrandKit(tmp);
    return null;
  } catch (err) {
    if (err instanceof BrandKitError) {
      const msg = err.message.replace(/^[^:]+:\s*/, "");
      return `${file} doesn't match the Brand Kit rules: ${msg}`;
    }
    const e = err as { name?: string; message?: string; linePos?: { line: number; col: number }[] };
    if (e?.name?.startsWith("YAML")) {
      const where = e.linePos?.[0] ? ` (line ${e.linePos[0].line}, column ${e.linePos[0].col})` : "";
      const first = (e.message ?? "").split("\n")[0]?.replace(/ at line \d+, column \d+:?$/, "") ?? "";
      return `${file} isn't valid YAML${where}: ${first}. Check the indentation and the colons on that line.`;
    }
    return `${file} couldn't be checked: ${e?.message ?? String(err)}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Saves one Brand Kit file. YAML is validated against the Brand Kit schemas first; nothing is written when it fails.
 * `baseHash` is the hash of the content the editor started from, so edits made elsewhere (an agent adding a lesson)
 * are never overwritten silently.
 */
export async function saveBrandFile(input: { file: string; content: string; baseHash: string }): Promise<SaveBrandResult> {
  await requireSession();
  const args = parse(saveInput, input);
  if (!args) return { ok: false, error: BAD_REQUEST };
  const { file, content, baseHash } = args;
  const abs = resolveBrandPath(file);
  if (!abs) return { ok: false, error: "That file isn't part of the Brand Kit, so Studio won't write it." };
  if (Buffer.byteLength(content) > MAX_BYTES) return { ok: false, error: "That file is too large to save from Studio (512 KB limit)." };

  const current = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  if (contentHash(current) !== baseHash) {
    return { ok: false, conflict: true, error: `${file} changed on disk since you opened it. Copy your edits, then reload to see the latest version.` };
  }
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized === current) return { ok: true, hash: baseHash, savedAt: new Date().toISOString(), message: `No changes to ${file}` };

  if (/\.ya?ml$/.test(file)) {
    const problem = validateYaml(file, normalized);
    if (problem) return { ok: false, error: problem };
  }

  const tmpPath = `${abs}.studio-${process.pid}.tmp`;
  writeFileSync(tmpPath, normalized);
  renameSync(tmpPath, abs);

  const ws = workspace();
  const hash = contentHash(normalized);
  await ws.sql`
    insert into brand_docs (workspace_id, path, content, content_hash, updated_at)
    values (${ws.id}, ${`brand/${file}`}, ${normalized}, ${hash}, now())
    on conflict (workspace_id, path) do update set content = excluded.content, content_hash = excluded.content_hash, updated_at = now()`;
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: ACTOR,
    kind: "progress",
    message: `Brand Kit updated: ${file}`,
    data: { file: `brand/${file}`, bytes: Buffer.byteLength(normalized) },
  });
  revalidatePath("/brand");
  return { ok: true, hash, savedAt: new Date().toISOString(), message: `Saved ${file}` };
}

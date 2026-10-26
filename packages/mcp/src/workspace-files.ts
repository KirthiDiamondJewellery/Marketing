import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolError } from "@attentionos/core";

const ROOTS = new Set(["brand", "scripts", "captions", "text-posts", "media"]);
const TEXT = /\.(md|txt|ya?ml|json|csv|srt|vtt)$/i;
const SECRET = /(?:^\.|secret|credential|token|password|private[-_]?key)/i;
const MAX_BYTES = 256 * 1024;

/** No dotfiles, executable configuration, secrets, symlinks, devices or paths outside content directories. */
export async function readWorkspaceContent(root: string, path: string): Promise<{ text?: string; entries?: string[] }> {
  const base = await realpath(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  const parts = rel.split(sep);
  if (!rel || isAbsolute(rel) || parts.includes("..") || !ROOTS.has(parts[0]!) || parts.some((p) => SECRET.test(p))) throw new ToolError("Only workspace content files can be read.");
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new ToolError("Symbolic links cannot be read by agents.");
  }
  const info = await lstat(target);
  if (info.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true });
    return { entries: entries.filter((e) => !SECRET.test(e.name) && (e.isDirectory() || (e.isFile() && TEXT.test(e.name)))).map((e) => `${path.replace(/\/$/, "")}/${e.name}${e.isDirectory() ? "/" : ""}`).sort().slice(0, 200) };
  }
  if (!info.isFile() || !TEXT.test(target) || info.size > MAX_BYTES) throw new ToolError("Only text content files up to 256 KB can be read.");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new ToolError("Not a regular content file.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_BYTES) throw new ToolError("Content file is too large.");
    return { text: buffer.subarray(0, size).toString("utf8") };
  } finally { await file.close(); }
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.ts";

/**
 * Engine files the CLI copies or reads (`templates/workspace`, `presets/<id>`, `media-py`), by repo-relative path.
 * From source this file sits at apps/cli/src, so three levels up is the repo.
 * The bundle mirrors the repo under dist/assets and rewrites `import.meta.url` to this file's mirrored location,
 * so the same lookup lands in dist/assets.
 */
export function engineRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

export function findAsset(rel: string): string | null {
  const path = join(engineRoot(), rel);
  return existsSync(path) ? path : null;
}

export function requireAsset(rel: string): string {
  const path = findAsset(rel);
  if (!path) throw new UserError(`This AttentionOS install is missing ${rel}.`, "Rebuild it from your AttentionOS folder: ./aos update");
  return path;
}

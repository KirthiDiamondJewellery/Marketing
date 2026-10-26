import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProviderError, type Storage } from "@attentionos/core";

/** Built-in `local` Storage: files live under `<workspace>/media/store/`, addressed as `local://<key>`. */
export function createLocalStorage(mediaDir: string): Storage {
  const base = resolve(mediaDir, "store");
  const pathOf = (key: string) => {
    const path = resolve(base, key);
    const rel = relative(base, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ProviderError("local", "invalid_request", `storage key escapes the store: ${key}`);
    return path;
  };
  const keyOf = (uri: string) => {
    if (!uri.startsWith("local://")) throw new ProviderError("local", "invalid_request", `not a local storage uri: ${uri}`);
    return uri.slice("local://".length);
  };
  return {
    id: "local",
    async health() {
      return { ok: true, detail: `Files are stored in ${base}` };
    },
    async put(localPath, key) {
      if (!existsSync(localPath)) throw new ProviderError("local", "not_found", `file not found: ${localPath}`);
      const dest = pathOf(key);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(localPath, dest);
      return { uri: `local://${key}` };
    },
    async get(uri, destPath) {
      const src = pathOf(keyOf(uri));
      if (!existsSync(src)) throw new ProviderError("local", "not_found", `not in the store: ${uri}`);
      mkdirSync(dirname(destPath), { recursive: true });
      if (resolve(destPath) !== src) copyFileSync(src, destPath);
      return { localPath: destPath };
    },
    async url(uri) {
      return pathToFileURL(join(pathOf(keyOf(uri)))).href;
    },
  };
}

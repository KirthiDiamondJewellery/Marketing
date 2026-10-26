import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrandKit, parseConfig, silentLogger, type AttentionOSConfigInput, type BrandKit, type Sql, type WorkspaceContext } from "@attentionos/core";
import { ensureWorkspace } from "@attentionos/db";
import { workspacePaths } from "@attentionos/runtime";

export async function fakeWorkspace(sql: Sql, slug: string, opts: { config?: AttentionOSConfigInput; secrets?: Record<string, string>; now?: Date } = {}): Promise<WorkspaceContext> {
  const root = mkdtempSync(join(tmpdir(), "aos-run-"));
  mkdirSync(join(root, "brand"), { recursive: true });
  writeFileSync(join(root, "brand", "brand.yaml"), "name: Examplebrand Studio\n");
  const config = parseConfig({ workspace: { name: "Examplebrand Studio", timezone: "America/Chicago" }, ...opts.config });
  const { id } = await ensureWorkspace(sql, { name: "Examplebrand Studio", slug, timezone: "America/Chicago" });
  const paths = workspacePaths(root);
  let brand: BrandKit | undefined;
  return {
    id, paths, config, sql, providers: { trendSources: {} }, log: silentLogger,
    brand: () => (brand ??= loadBrandKit(paths.brand)),
    reloadBrand: () => (brand = loadBrandKit(paths.brand)),
    now: () => opts.now ?? new Date(),
    secret: (n) => opts.secrets?.[n],
  };
}

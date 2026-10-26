import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAND_FILES } from "@attentionos/core";
import { workspace } from "@/server/workspace";

/**
 * Brand Kit files: taste lives in plain files in `<workspace>/brand/`. Studio reads and writes the files
 * themselves; the database only keeps a read-only index (`brand_docs`).
 */

export type BrandGroup = "identity" | "making" | "watching" | "learning";

export type BrandFileMeta = {
  file: string;
  /** Path relative to the workspace root, e.g. brand/voice.md. */
  path: string;
  kind: "yaml" | "md";
  title: string;
  description: string;
  group: BrandGroup;
  exists: boolean;
  bytes: number;
  modifiedAt: string | null;
  /** lessons.md is written by agents (read-mostly); knowledge docs are read-only here. */
  mode: "edit" | "read_mostly" | "read_only";
};

const META: Record<string, { title: string; description: string; group: BrandGroup }> = {
  [BRAND_FILES.brand]: { title: "Brand", description: "Name, handles, offers, how people convert and phrases you never use.", group: "identity" },
  [BRAND_FILES.icp]: { title: "Ideal customer", description: "Who you talk to and the words they use.", group: "identity" },
  [BRAND_FILES.voice]: { title: "Voice", description: "How you sound, from your own transcripts, and what to avoid.", group: "identity" },
  [BRAND_FILES.offers]: { title: "Offers", description: "What you sell and which results may be claimed.", group: "identity" },
  [BRAND_FILES.pillars]: { title: "Pillars", description: "Lanes, angles, story structures and rejected ideas.", group: "making" },
  [BRAND_FILES.proofInventory]: { title: "Proof inventory", description: "Case studies, wins and stats. The only source of numbers.", group: "making" },
  [BRAND_FILES.houseStyle]: { title: "House style", description: "Editing taste every edit inherits.", group: "making" },
  [BRAND_FILES.competitors]: { title: "Competitors", description: "Creators the research scan follows, by platform and tier.", group: "watching" },
  [BRAND_FILES.sources]: { title: "Trend sources", description: "News and trend feeds for your niche.", group: "watching" },
  [BRAND_FILES.lessons]: { title: "Lessons", description: "Dated rules from your corrections. Agents add these.", group: "learning" },
};

export const EDITABLE_FILES: readonly string[] = Object.values(BRAND_FILES);

export function brandDir(): string {
  return join(workspace().root, "brand");
}

export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex");

function meta(file: string, path: string, mode: BrandFileMeta["mode"], fallback?: { title: string; description: string; group: BrandGroup }): BrandFileMeta {
  const m = META[file] ?? fallback ?? { title: file, description: "", group: "learning" as const };
  const exists = existsSync(path);
  const st = exists ? statSync(path) : null;
  return {
    file,
    path: `brand/${file}`,
    kind: file.endsWith(".yaml") || file.endsWith(".yml") ? "yaml" : "md",
    title: m.title,
    description: m.description,
    group: m.group,
    exists,
    bytes: st?.size ?? 0,
    modifiedAt: st?.mtime.toISOString() ?? null,
    mode,
  };
}

export function listBrandFiles(): BrandFileMeta[] {
  const dir = brandDir();
  const out = EDITABLE_FILES.map((f) => meta(f, join(dir, f), f === BRAND_FILES.lessons ? "read_mostly" : "edit"));
  const kdir = join(dir, "knowledge");
  if (existsSync(kdir)) {
    for (const f of readdirSync(kdir).filter((x) => x.endsWith(".md")).sort()) {
      const name = f.replace(/\.md$/, "");
      out.push(
        meta(`knowledge/${f}`, join(kdir, f), "read_only", {
          title: name === "README" ? "Knowledge guide" : name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " "),
          description: "A deep reference doc. Edit it in your workspace folder.",
          group: "learning",
        }),
      );
    }
  }
  return out;
}

export function readBrandFile(file: string): { meta: BrandFileMeta; content: string; hash: string } | null {
  const list = listBrandFiles();
  const m = list.find((x) => x.file === file);
  if (!m) return null;
  const content = m.exists ? readFileSync(join(brandDir(), file), "utf8") : "";
  return { meta: m, content, hash: contentHash(content) };
}

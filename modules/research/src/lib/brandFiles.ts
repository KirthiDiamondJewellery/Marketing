import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLMap } from "yaml";
import { BRAND_FILES, type Platform } from "@attentionos/core";

/**
 * Edits to Brand Kit YAML files that keep the user's comments and formatting (taste lives in files).
 */

export const normaliseHandle = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

export type CompetitorEdit = { handle: string; platform: Platform; tier?: string; notes?: string };

function loadCompetitorsDoc(brandDir: string) {
  const path = join(brandDir, BRAND_FILES.competitors);
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "creators: []\n");
  if (!isMap(doc.contents)) doc.contents = doc.createNode({ creators: [] }) as never;
  let creators = doc.get("creators");
  if (!isSeq(creators)) {
    doc.set("creators", doc.createNode([]));
    creators = doc.get("creators");
  }
  return { path, doc, creators: creators as ReturnType<typeof doc.createNode> & { items: unknown[] } };
}

const matches = (item: unknown, handle: string, platform: string) =>
  isMap(item) && normaliseHandle(String(item.get("handle") ?? "")) === normaliseHandle(handle) && String(item.get("platform")) === platform;

/** Adds (or updates) a creator in competitors.yaml. Returns "added" or "updated". */
export function upsertCompetitorInFile(brandDir: string, c: CompetitorEdit): "added" | "updated" {
  const { path, doc, creators } = loadCompetitorsDoc(brandDir);
  const existing = creators.items.find((i) => matches(i, c.handle, c.platform));
  if (existing && isMap(existing)) {
    if (c.tier) existing.set("tier", c.tier);
    if (c.notes) existing.set("notes", c.notes);
    writeFileSync(path, doc.toString());
    return "updated";
  }
  const node = new YAMLMap();
  node.set("handle", normaliseHandle(c.handle));
  node.set("platform", c.platform);
  node.set("tier", c.tier ?? "core");
  if (c.notes) node.set("notes", c.notes);
  creators.items.push(node);
  writeFileSync(path, doc.toString());
  return "added";
}

/** Removes a creator from competitors.yaml. Returns false when it wasn't listed. */
export function removeCompetitorFromFile(brandDir: string, handle: string, platform: Platform): boolean {
  const { path, doc, creators } = loadCompetitorsDoc(brandDir);
  const before = creators.items.length;
  creators.items = creators.items.filter((i) => !matches(i, handle, platform));
  if (creators.items.length === before) return false;
  writeFileSync(path, doc.toString());
  return true;
}

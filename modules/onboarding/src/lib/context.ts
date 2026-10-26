import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { WorkspaceContext } from "@attentionos/core";

/** Where this module's skills live (also handed to the runner via `skillsDir`). */
export const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/**
 * A skill's method text without its front matter. Tool-less jobs don't get the skill in their system prompt, so their
 * prompt carries it. Missing file = empty string (the prompt still states the essentials).
 */
export function skillText(name: string): string {
  const file = join(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").replace(/^---[\s\S]*?\n---\n/, "").trim().slice(0, 12_000);
}

function read(ws: WorkspaceContext, file: string, max: number): string {
  const path = join(ws.paths.brand, file);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

/**
 * Trusted Brand Kit context for prompts (the owner's own files), read straight from disk so a half-filled kit never
 * stops onboarding the way `ws.brand()` would.
 */
export function brandContext(ws: WorkspaceContext, opts: { icp?: number; offers?: number; voice?: number } = {}) {
  let brand: { name?: string; oneLiner?: string; website?: string; handles?: Record<string, string> } = {};
  try {
    brand = (parseYaml(read(ws, "brand.yaml", 20_000)) as typeof brand) ?? {};
  } catch {
    brand = {};
  }
  return {
    name: typeof brand.name === "string" && !brand.name.includes("{{") ? brand.name : ws.config.workspace.name,
    oneLiner: typeof brand.oneLiner === "string" ? brand.oneLiner : "",
    website: typeof brand.website === "string" ? brand.website : "",
    handles: brand.handles && typeof brand.handles === "object" ? brand.handles : {},
    icp: opts.icp ? read(ws, "icp.md", opts.icp) : "",
    offers: opts.offers ? read(ws, "offers.md", opts.offers) : "",
    voice: opts.voice ? read(ws, "voice.md", opts.voice) : "",
    preset: ws.config.workspace.preset,
    platforms: ws.config.platforms,
  };
}

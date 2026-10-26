import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { BRAND_FILES, CTA_TYPES, FUNNEL_STAGES, pillarSchema, type CtaType, type FunnelStage } from "@attentionos/core";

/**
 * Reads `brand/pillars.md` the way the workspace template writes it:
 * - YAML front matter: `lanes: [{id, name, weeklyQuota, funnelStage, description}]` (core `pillarSchema`), with
 *   optional per-lane `kinds` and `proofKinds` overrides;
 * - markdown sections: "## Main angle", "## Sub-angles", "## Story structures", "## Rejected concepts"
 *   (`- YYYY-MM-DD · idea · why`).
 * Preset defaults live in `brand/knowledge/preset-cadence.yaml`, `preset-cta.yaml` and `preset-formats.md`.
 */

export const IDEA_KINDS = ["news", "remix", "talking_head", "offer"] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];

export const PROOF_KINDS = ["case_study", "client_win", "faq", "objection", "process", "build", "story", "stat"] as const;

const laneExtras = z.object({
  /** What this lane can be filled with. Default inferred from the lane's id/name and funnel stage. */
  kinds: z.array(z.enum(IDEA_KINDS)).optional(),
  /** Which proof-inventory kinds feed this lane. Default inferred. */
  proofKinds: z.array(z.enum(PROOF_KINDS)).optional(),
});

const frontMatterSchema = pillarSchema.extend({
  lanes: z.array(pillarSchema.shape.lanes.unwrap().element.extend(laneExtras.shape)).default([]),
  /** Optional overrides; the markdown sections are the usual place for these. */
  templates: z.partialRecord(z.enum(IDEA_KINDS), z.array(z.string())).optional(),
  cooldowns: z.object({
    topicDays: z.number().int().positive().optional(),
    proofDays: z.number().int().positive().optional(),
    angleDays: z.number().int().nonnegative().optional(),
  }).optional(),
}).passthrough();

export type Lane = {
  id: string;
  name: string;
  weeklyQuota: number;
  funnelStage: FunnelStage;
  description: string;
  kinds: IdeaKind[];
  proofKinds: string[];
};

export type StoryStructure = { id: string; name: string; description: string };
export type RejectedConcept = { date: string | null; text: string; why: string | null };

export type Pillars = {
  lanes: Lane[];
  /** True when the file had no lanes and generic per-funnel-stage lanes are used. */
  fallbackLanes: boolean;
  mainAngle: string | null;
  angles: { id: string; text: string }[];
  storyStructures: StoryStructure[];
  rejected: RejectedConcept[];
  templates: Partial<Record<IdeaKind, string[]>>;
  cooldowns: { topicDays?: number; proofDays?: number; angleDays?: number };
  problems: string[];
};

/** Method defaults (not brand content): used only when pillars.md lists no story structures. */
export const DEFAULT_STORY_STRUCTURES: StoryStructure[] = [
  { id: "before-after", name: "Before and after", description: "where they started, what changed, where they are now" },
  { id: "the-mistake", name: "The mistake", description: "a costly mistake, what it cost, the fix" },
  { id: "contrarian-call", name: "The contrarian call", description: "what everyone recommends, why you disagree, what you do instead" },
  { id: "teardown", name: "The teardown", description: "take one example apart, step by step" },
  { id: "list-twist", name: "The list with a twist", description: "three things, and the third one is the surprise" },
  { id: "day-in-life", name: "The day in the life", description: "one real day, compressed, with one lesson" },
  { id: "question-most", name: "The question I get most", description: "the question, the usual answer, your answer" },
];

const FALLBACK_LANES: Lane[] = [
  { id: "reach", name: "Reach", weeklyQuota: 3, funnelStage: "tofu", description: "", kinds: ["news", "remix", "talking_head"], proofKinds: ["faq", "story"] },
  { id: "trust", name: "Trust", weeklyQuota: 2, funnelStage: "mofu", description: "", kinds: ["remix", "talking_head"], proofKinds: ["case_study", "client_win", "process", "build", "objection"] },
  { id: "offer", name: "Offer", weeklyQuota: 1, funnelStage: "bofu", description: "", kinds: ["offer"], proofKinds: ["case_study", "client_win"] },
];

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** Lane kinds/proof kinds when the lane doesn't say: inferred from its words and funnel stage. */
export function inferLaneKinds(lane: { id: string; name: string; description?: string; funnelStage: FunnelStage }): { kinds: IdeaKind[]; proofKinds: string[] } {
  const words = `${lane.id} ${lane.name}`.toLowerCase();
  const desc = (lane.description ?? "").toLowerCase();
  let kinds: IdeaKind[];
  if (/news|trend/.test(words)) kinds = ["news"];
  else if (/offer|invite|book|sale/.test(words) && lane.funnelStage === "bofu") kinds = ["offer"];
  else kinds = ["talking_head", "remix"];
  const all = `${words} ${desc}`;
  const proofKinds: string[] = [];
  if (/proof|win|result|case|client/.test(all)) proofKinds.push("case_study", "client_win", "build", "stat");
  if (/question|faq|ask/.test(all)) proofKinds.push("faq");
  if (/objection|myth|wrong|believe/.test(all)) proofKinds.push("objection");
  if (/process|behind|how you|scenes/.test(all)) proofKinds.push("process", "build");
  if (/story|journey/.test(all)) proofKinds.push("story");
  if (kinds[0] === "offer") proofKinds.push("case_study", "client_win");
  return { kinds, proofKinds: [...new Set(proofKinds)] };
}

export function splitFrontMatter(md: string): { yaml: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  return m ? { yaml: m[1]!, body: md.slice(m[0].length) } : { yaml: null, body: md };
}

/** Sections of a markdown body by "## " heading (lowercased), HTML comments removed. */
export function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = body.replace(/<!--[\s\S]*?-->/g, "");
  const parts = clean.split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const title = (nl === -1 ? p : p.slice(0, nl)).trim().toLowerCase();
    out.set(title, nl === -1 ? "" : p.slice(nl + 1).trim());
  }
  return out;
}

const listItems = (s: string | undefined) =>
  (s ?? "").split("\n").map((l) => /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);

export function parseRejected(section: string | undefined): RejectedConcept[] {
  return listItems(section).map((item) => {
    const parts = item.split(/\s+·\s+/);
    if (parts.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]!)) return { date: parts[0]!, text: parts[1]!, why: parts.slice(2).join(" · ") || null };
    return { date: null, text: item, why: null };
  });
}

export function parsePillars(md: string | undefined): Pillars {
  const problems: string[] = [];
  const { yaml, body } = splitFrontMatter(md ?? "");
  let fm: z.output<typeof frontMatterSchema> = frontMatterSchema.parse({});
  if (yaml !== null) {
    const parsed = frontMatterSchema.safeParse(parseYaml(yaml) ?? {});
    if (parsed.success) fm = parsed.data;
    else problems.push(`brand/pillars.md front matter: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const lanes: Lane[] = fm.lanes.map((l) => {
    const inferred = inferLaneKinds(l);
    return { id: l.id, name: l.name, weeklyQuota: l.weeklyQuota, funnelStage: l.funnelStage, description: l.description, kinds: l.kinds ?? inferred.kinds, proofKinds: l.proofKinds ?? inferred.proofKinds };
  });
  const sec = sections(body);
  const mainAngle = (sec.get("main angle") ?? "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? null;
  const angles = listItems(sec.get("sub-angles") ?? sec.get("angles")).map((text) => ({ id: slug(text), text }));
  const structures = listItems(sec.get("story structures")).map((item) => {
    const m = /^\*\*(.+?)\*\*\s*[:\-–]?\s*(.*)$/.exec(item);
    const name = (m?.[1] ?? item.split(":")[0]!).trim();
    return { id: slug(name), name, description: (m?.[2] ?? item.split(":").slice(1).join(":")).trim() };
  });
  return {
    lanes: lanes.length ? lanes : FALLBACK_LANES,
    fallbackLanes: lanes.length === 0,
    mainAngle,
    angles,
    storyStructures: structures.length ? structures : DEFAULT_STORY_STRUCTURES,
    rejected: parseRejected(sec.get("rejected concepts")),
    templates: fm.templates ?? {},
    cooldowns: fm.cooldowns ?? {},
    problems,
  };
}

/** Appends a rejected concept to the "## Rejected concepts" section, creating it if needed. */
export function appendRejectedConcept(brandDir: string, c: { date: string; text: string; why?: string }): void {
  const path = join(brandDir, BRAND_FILES.pillars);
  const md = existsSync(path) ? readFileSync(path, "utf8") : "";
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+·\s+/g, " - ").trim();
  const line = `- ${c.date} · ${clean(c.text)}${c.why ? ` · ${clean(c.why)}` : ""}`;
  const heading = /^##\s+Rejected concepts\s*$/im.exec(md);
  let out: string;
  if (!heading) {
    out = `${md.replace(/\s*$/, "")}\n\n## Rejected concepts\n\n${line}\n`;
  } else {
    const start = heading.index + heading[0].length;
    const next = /^##\s+/m.exec(md.slice(start));
    const end = next ? start + next.index : md.length;
    const section = md.slice(start, end).replace(/\s*$/, "");
    out = `${md.slice(0, start)}${section}\n${line}\n${next ? `\n${md.slice(end)}` : ""}`;
  }
  writeFileSync(path, out);
}

// ---------------------------------------------------------------------------
// Preset files in brand/knowledge/
// ---------------------------------------------------------------------------

export type PresetDefaults = {
  /** Short videos per week from preset-cadence.yaml (batch-day size). */
  weeklyShortVideos: number | null;
  ctaByStage: Partial<Record<FunnelStage, CtaType>>;
  /** Format template id → shoot directions, from preset-formats.md. */
  formats: Record<string, { useFor: string; shootDirections: string }>;
};

const cadenceSchema = z.object({ weeklyTarget: z.object({ shortVideos: z.number().int().positive().optional() }).optional() }).passthrough();
const ctaSchema = z.object({ byFunnelStage: z.partialRecord(z.enum(FUNNEL_STAGES), z.object({ default: z.enum(CTA_TYPES) }).passthrough()).optional() }).passthrough();

function readYamlSafe<T extends z.ZodType>(path: string, schema: T): z.output<T> | null {
  if (!existsSync(path)) return null;
  const parsed = schema.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
  return parsed.success ? parsed.data : null;
}

export function parseFormatsTable(md: string | undefined): PresetDefaults["formats"] {
  const out: PresetDefaults["formats"] = {};
  for (const line of (md ?? "").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6) continue;
    const id = /^`([a-z0-9-]+)`$/.exec(cells[1] ?? "")?.[1];
    if (!id) continue;
    out[id] = { useFor: cells[3] ?? "", shootDirections: cells[4] ?? "" };
  }
  return out;
}

export function loadPresetDefaults(brandDir: string, docs: Record<string, string>): PresetDefaults {
  const cadence = readYamlSafe(join(brandDir, "knowledge", "preset-cadence.yaml"), cadenceSchema);
  const cta = readYamlSafe(join(brandDir, "knowledge", "preset-cta.yaml"), ctaSchema);
  const ctaByStage: PresetDefaults["ctaByStage"] = {};
  for (const stage of FUNNEL_STAGES) {
    const d = cta?.byFunnelStage?.[stage]?.default;
    if (d) ctaByStage[stage] = d;
  }
  return {
    weeklyShortVideos: cadence?.weeklyTarget?.shortVideos ?? null,
    ctaByStage,
    formats: parseFormatsTable(docs["knowledge/preset-formats"]),
  };
}

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CTA_TYPES, FUNNEL_STAGES, PLATFORMS } from "./types.ts";

/**
 * Brand Kit: plain files in `<workspace>/brand/`. Taste lives in files, facts live in the database.
 * Engine code and skills may only REFERENCE these files, never embed brand literals.
 */

export const BRAND_FILES = {
  brand: "brand.yaml",
  icp: "icp.md",
  voice: "voice.md",
  offers: "offers.md",
  pillars: "pillars.md",
  proofInventory: "proof-inventory.yaml",
  houseStyle: "house-style.md",
  competitors: "competitors.yaml",
  sources: "sources.yaml",
  lessons: "lessons.md",
} as const;

export const brandSchema = z.object({
  name: z.string().min(1),
  /** One line: what the business does and for whom. */
  oneLiner: z.string().default(""),
  website: z.string().url().optional(),
  timezone: z.string().default("America/New_York"),
  handles: z.partialRecord(z.enum(PLATFORMS), z.string()).default({}),
  offers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    url: z.string().url().optional(),
    /** Default CTA used when promoting this offer. */
    cta: z.enum(CTA_TYPES).default("book_call"),
  })).default([]),
  cta: z.object({
    /** How the audience converts by default. */
    primary: z.enum(CTA_TYPES).default("comment_keyword"),
    /** Where lead magnets are hosted and tracked links point. */
    siteUrl: z.string().url().optional(),
    /** Prefix for utm_content: `<prefix><keyword>_<post#>`. Empty by default. */
    utmContentPrefix: z.string().default(""),
  }).default({ primary: "comment_keyword", utmContentPrefix: "" }),
  funnelMix: z.object({ tofu: z.number(), mofu: z.number(), bofu: z.number() })
    .refine((m) => Math.abs(m.tofu + m.mofu + m.bofu - 100) < 0.01, "funnel mix must sum to 100")
    .default({ tofu: 50, mofu: 30, bofu: 20 }),
  /** Words/phrases that may never appear in scripts or captions (in addition to voice.md). */
  bannedPhrases: z.array(z.string()).default([]),
  /** Hashtags we're allowed to use (3–5 picked per post). */
  hashtagPool: z.array(z.string().regex(/^#?[\p{L}\p{N}_]+$/u)).default([]),
});
export type Brand = z.output<typeof brandSchema>;

export const proofItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["case_study", "client_win", "faq", "objection", "process", "build", "story", "stat"]),
  title: z.string(),
  summary: z.string(),
  /** The ONLY allowed source of numbers in proof content. */
  numbers: z.array(z.object({ value: z.string(), label: z.string(), source: z.string() })).default([]),
  /** Never name a client without consent. */
  clientConsent: z.boolean().default(false),
  lastUsedAt: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export const proofInventorySchema = z.object({ items: z.array(proofItemSchema).default([]) });
export type ProofItem = z.output<typeof proofItemSchema>;

export const competitorSchema = z.object({
  handle: z.string(),
  platform: z.enum(PLATFORMS),
  /** Tier drives rotation frequency and weighting. */
  tier: z.enum(["core", "adjacent", "aspirational", "remake"]).default("core"),
  notes: z.string().optional(),
});
export const competitorsSchema = z.object({ creators: z.array(competitorSchema).default([]) });
export type Competitor = z.output<typeof competitorSchema>;

export const trendSourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["rss", "google_news", "hn", "reddit", "github", "x_apify"]),
  /** Feed URL, subreddit, search query or account list, depending on kind. */
  target: z.string(),
  weight: z.number().positive().default(1),
  enabled: z.boolean().default(true),
});
export const sourcesSchema = z.object({ sources: z.array(trendSourceSchema).default([]) });
export type TrendSourceConfig = z.output<typeof trendSourceSchema>;

export const pillarSchema = z.object({
  lanes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    weeklyQuota: z.number().int().nonnegative(),
    funnelStage: z.enum(FUNNEL_STAGES),
    description: z.string().default(""),
  })).default([]),
});

export type BrandKit = {
  dir: string;
  brand: Brand;
  proofInventory: z.output<typeof proofInventorySchema>;
  competitors: z.output<typeof competitorsSchema>;
  sources: z.output<typeof sourcesSchema>;
  /** Markdown docs, keyed by file name without extension (icp, voice, offers, pillars, house-style, lessons, knowledge/*). */
  docs: Record<string, string>;
};

export class BrandKitError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "BrandKitError";
  }
}

function readYaml<T extends z.ZodType>(dir: string, file: string, schema: T, required: boolean): z.output<T> {
  const path = join(dir, file);
  if (!existsSync(path)) {
    if (required) throw new BrandKitError(file, "missing (run `attentionos init` to create it)");
    return schema.parse({});
  }
  const parsed = schema.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
  if (!parsed.success) {
    throw new BrandKitError(file, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

/** Loads and validates a workspace's Brand Kit. Throws BrandKitError with a plain-language message. */
export function loadBrandKit(brandDir: string): BrandKit {
  const docs: Record<string, string> = {};
  for (const file of [BRAND_FILES.icp, BRAND_FILES.voice, BRAND_FILES.offers, BRAND_FILES.pillars, BRAND_FILES.houseStyle, BRAND_FILES.lessons]) {
    const path = join(brandDir, file);
    if (existsSync(path)) docs[file.replace(/\.md$/, "")] = readFileSync(path, "utf8");
  }
  const knowledgeDir = join(brandDir, "knowledge");
  if (existsSync(knowledgeDir)) {
    for (const file of readdirSync(knowledgeDir).filter((f) => f.endsWith(".md")).sort()) {
      docs[`knowledge/${file.replace(/\.md$/, "")}`] = readFileSync(join(knowledgeDir, file), "utf8");
    }
  }
  return {
    dir: brandDir,
    brand: readYaml(brandDir, BRAND_FILES.brand, brandSchema, true),
    proofInventory: readYaml(brandDir, BRAND_FILES.proofInventory, proofInventorySchema, false),
    competitors: readYaml(brandDir, BRAND_FILES.competitors, competitorsSchema, false),
    sources: readYaml(brandDir, BRAND_FILES.sources, sourcesSchema, false),
    docs,
  };
}

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { WorkspaceContext } from "@attentionos/core";
import { LAST_INDEX_KEY, SOURCE_TYPES, type SourceType } from "./constants.ts";
import { workspaceEmbedder, type Embedder } from "./embedder.ts";
import { deleteSource, deleteStaleSources, indexSources, type IndexResult, type SourceDoc } from "./store.ts";

/**
 * Workspace indexers: everything worth recalling, gathered from the Brand Kit files and the database.
 * Trust: the owner's own words and our validated outputs are "own"; anything written by other people
 * (competitor captions, transcripts, comments, and analyses that quote them) is "untrusted".
 */

const MAX_FILE_BYTES = 1_000_000;
const FILE_EXT = /\.(md|markdown|txt|ya?ml)$/i;

const toPosix = (p: string) => p.split(sep).join("/");

/** Workspace-relative path of a Brand Kit file and the source type it belongs to (null = not indexable). */
export function classifyBrandPath(ws: WorkspaceContext, file: string): { rel: string; sourceType: SourceType } | null {
  const abs = isAbsolute(file) ? file : resolve(ws.paths.root, file);
  const brandRel = toPosix(relative(ws.paths.brand, abs));
  if (!brandRel || brandRel.startsWith("..") || isAbsolute(brandRel)) return null;
  if (!FILE_EXT.test(brandRel) || brandRel.split("/").some((part) => part.startsWith("."))) return null;
  const rel = toPosix(relative(ws.paths.root, abs));
  if (brandRel.startsWith("knowledge/")) return { rel, sourceType: "knowledge_doc" };
  if (brandRel.includes("/")) return null; // other sub-folders of brand/ aren't part of the Brand Kit
  if (brandRel === "lessons.md") return { rel, sourceType: "lesson" };
  return { rel, sourceType: "brand_doc" };
}


/** Reads one Brand Kit file into a SourceDoc (null when it isn't indexable or no longer exists). */
export function brandFileSource(ws: WorkspaceContext, file: string): SourceDoc | null {
  const c = classifyBrandPath(ws, file);
  if (!c) return null;
  const abs = resolve(ws.paths.root, c.rel);
  if (!existsSync(abs)) return null;
  const st = statSync(abs);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const text = readFileSync(abs, "utf8");
  // The title is the file's place in the Brand Kit ("voice.md", "knowledge/process.md"); headings add the rest.
  const title = c.rel.replace(/^brand\//, "");
  return { sourceType: c.sourceType, sourceId: c.rel, path: c.rel, title, text, trust: "own", metadata: {}, sourceDate: null };
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && FILE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

/** Every indexable file in brand/ (top level) and brand/knowledge/** . */
export function brandFiles(ws: WorkspaceContext): string[] {
  if (!existsSync(ws.paths.brand)) return [];
  const top = readdirSync(ws.paths.brand, { withFileTypes: true }).filter((e) => e.isFile() && FILE_EXT.test(e.name) && !e.name.startsWith(".")).map((e) => join(ws.paths.brand, e.name)).sort();
  return [...top, ...walk(join(ws.paths.brand, "knowledge"))];
}

type Collector = { types: SourceType[]; collect(ws: WorkspaceContext): Promise<SourceDoc[]> };

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null);
const short = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** Untrusted text never gets to pose as our own prompt delimiters. */
const fence = (s: string | null | undefined) => (s ?? "").replace(/<\/?\s*untrusted[^>]*>/gi, "");

const brandCollector: Collector = {
  types: ["brand_doc", "knowledge_doc", "lesson"],
  async collect(ws) {
    return brandFiles(ws).map((f) => brandFileSource(ws, f)).filter((d): d is SourceDoc => d !== null);
  },
};

const ownPostsCollector: Collector = {
  types: ["own_caption", "own_transcript"],
  async collect(ws) {
    const rows = await ws.sql<{
      id: string; platform: string; url: string | null; caption: string | null; transcript: string | null; published_at: Date | null;
      title: string | null; lane: string | null; hook_pattern: string | null; x_score: string | null;
    }[]>`
      select p.id, p.platform, p.url, p.caption, p.payload->>'transcript' as transcript, p.published_at,
             c.title, c.lane, c.hook_pattern,
             (select m.x_score from post_metrics m where m.post_id = p.id and m.x_score is not null order by m.captured_at desc limit 1) as x_score
        from posts p left join content c on c.id = p.content_id
       where p.workspace_id = ${ws.id} and p.status = 'published'
       order by p.published_at desc nulls last
       limit 5000`;
    const docs: SourceDoc[] = [];
    for (const r of rows) {
      const metadata = { postId: r.id, platform: r.platform, url: r.url ?? undefined, lane: r.lane ?? undefined, hookPattern: r.hook_pattern ?? undefined, x: r.x_score === null ? undefined : Number(r.x_score) };
      const title = `${r.title ?? "Post"} (${r.platform}${r.published_at ? `, ${iso(r.published_at)!.slice(0, 10)}` : ""})`;
      if (r.caption?.trim()) docs.push({ sourceType: "own_caption", sourceId: r.id, title, text: r.caption, trust: "own", metadata, sourceDate: r.published_at, format: "text" });
      if (r.transcript?.trim()) docs.push({ sourceType: "own_transcript", sourceId: r.id, title, text: r.transcript, trust: "own", metadata, sourceDate: r.published_at, format: "text" });
    }
    return docs;
  },
};

const scriptsCollector: Collector = {
  types: ["script"],
  async collect(ws) {
    // The newest version per content item, approved ones first.
    const rows = await ws.sql<{ id: string; content_id: string; version: number; body: string; status: string; created_at: Date; title: string; lane: string | null; content_status: string; hook_pattern: string | null }[]>`
      select distinct on (s.content_id) s.id, s.content_id, s.version, s.body, s.status, s.created_at,
             c.title, c.lane, c.status as content_status, c.hook_pattern
        from scripts s join content c on c.id = s.content_id
       where s.workspace_id = ${ws.id} and s.status <> 'rejected'
       order by s.content_id, (s.status = 'approved') desc, s.version desc
       limit 5000`;
    return rows.map((r) => ({
      sourceType: "script" as const,
      sourceId: r.content_id,
      title: `Script: ${r.title}`,
      text: r.body,
      trust: "own" as const,
      metadata: { contentId: r.content_id, scriptId: r.id, version: r.version, status: r.status, contentStatus: r.content_status, lane: r.lane ?? undefined, hookPattern: r.hook_pattern ?? undefined },
      sourceDate: r.created_at,
      format: "text" as const,
    }));
  },
};

const competitorCollector: Collector = {
  types: ["competitor_transcript", "comment_gold"],
  async collect(ws) {
    const rows = await ws.sql<{ id: string; platform: string; author_handle: string; url: string; caption: string | null; transcript: string | null; spoken_hook: string | null; top_comments: { text?: string; likes?: number }[] | null; x_score: string | null; is_outlier: boolean; published_at: Date | null }[]>`
      select id, platform, author_handle, url, caption, transcript, spoken_hook, top_comments, x_score, is_outlier, published_at
        from external_posts
       where workspace_id = ${ws.id} and (transcript is not null or top_comments is not null)
       order by published_at desc nulls last
       limit 3000`;
    const docs: SourceDoc[] = [];
    for (const r of rows) {
      const metadata = { externalPostId: r.id, platform: r.platform, creator: `@${r.author_handle}`, url: r.url, x: r.x_score === null ? undefined : Number(r.x_score), outlier: r.is_outlier };
      const title = `@${fence(r.author_handle)} on ${r.platform}${r.published_at ? ` (${iso(r.published_at)!.slice(0, 10)})` : ""}`;
      if (r.transcript?.trim()) {
        const parts = [r.spoken_hook ? `Spoken hook: ${fence(r.spoken_hook)}` : "", r.caption ? `Caption: ${fence(r.caption)}` : "", `Transcript: ${fence(r.transcript)}`].filter(Boolean);
        docs.push({ sourceType: "competitor_transcript", sourceId: r.id, title, text: parts.join("\n\n"), trust: "untrusted", metadata, sourceDate: r.published_at, format: "text" });
      }
      const comments = (r.top_comments ?? []).filter((c) => c?.text?.trim()).slice(0, 25);
      if (comments.length) {
        const text = comments.map((c) => `- ${fence(c.text)}${c.likes ? ` (${c.likes} likes)` : ""}`).join("\n");
        docs.push({ sourceType: "comment_gold", sourceId: r.id, title: `Top comments: ${title}`, text, trust: "untrusted", metadata, sourceDate: r.published_at, format: "text" });
      }
    }
    return docs;
  },
};

const hooksCollector: Collector = {
  types: ["hook"],
  async collect(ws) {
    // Competitor hooks are indexed only as their validated abstract (structure with [placeholders]), never their words.
    const hasAbstract = await ws.sql`select 1 from information_schema.columns where table_name = 'hooks' and column_name = 'abstract' and table_schema = current_schema()`;
    const rows = await ws.sql<{ id: string; text: string; abstract: string | null; pattern: string; origin: string; score: string | null; wins: number; uses: number; created_at: Date }[]>`
      select id, text, ${hasAbstract.length ? ws.sql`abstract` : ws.sql`null::text as abstract`}, pattern, origin, score, wins, uses, created_at
        from hooks where workspace_id = ${ws.id} and status = 'active'
       order by created_at desc limit 5000`;
    const docs: SourceDoc[] = [];
    for (const r of rows) {
      const text = r.origin === "competitor" ? r.abstract : r.text;
      if (!text?.trim()) continue;
      docs.push({
        sourceType: "hook",
        sourceId: r.id,
        title: `${r.origin === "competitor" ? "Competitor hook structure" : "Own hook"} (${r.pattern})`,
        text,
        trust: "own",
        metadata: { hookId: r.id, pattern: r.pattern, origin: r.origin, score: r.score === null ? undefined : Number(r.score), wins: r.wins, uses: r.uses },
        sourceDate: r.created_at,
        format: "text",
      });
    }
    return docs;
  },
};

const postMortemCollector: Collector = {
  types: ["post_mortem"],
  async collect(ws) {
    const rows = await ws.sql<{ id: string; post_id: string | null; kind: string; x_score: string | null; body_md: string; lessons: { text?: string }[] | null; created_at: Date }[]>`
      select id, post_id, kind, x_score, body_md, lessons, created_at from post_mortems where workspace_id = ${ws.id} order by created_at desc limit 2000`;
    return rows.map((r) => {
      const lessons = (r.lessons ?? []).map((l) => l?.text).filter(Boolean);
      return {
        sourceType: "post_mortem" as const,
        sourceId: r.id,
        title: `Post-mortem: ${r.kind.replace("_", " ")} (${iso(r.created_at)!.slice(0, 10)})`,
        text: lessons.length ? `${r.body_md}\n\n## Lessons\n\n${lessons.map((l) => `- ${l}`).join("\n")}` : r.body_md,
        trust: "own" as const,
        metadata: { postMortemId: r.id, postId: r.post_id ?? undefined, kind: r.kind, x: r.x_score === null ? undefined : Number(r.x_score) },
        sourceDate: r.created_at,
      };
    });
  },
};

const teardownCollector: Collector = {
  types: ["teardown"],
  async collect(ws) {
    const rows = await ws.sql<{ id: string; url: string; author_handle: string | null; platform: string | null; analysis_md: string; created_at: Date }[]>`
      select id, url, author_handle, platform, analysis_md, created_at from teardowns where workspace_id = ${ws.id} order by created_at desc limit 1000`;
    return rows.map((r) => ({
      sourceType: "teardown" as const,
      sourceId: r.id,
      title: `Teardown: ${r.author_handle ? `@${fence(r.author_handle)}` : "post"}${r.platform ? ` on ${r.platform}` : ""}`,
      text: fence(r.analysis_md),
      // Written by our agent, but it quotes the creator's words: treat it as data.
      trust: "untrusted" as const,
      metadata: { teardownId: r.id, url: r.url, platform: r.platform ?? undefined },
      sourceDate: r.created_at,
    }));
  },
};

function kitText(story: unknown): string {
  if (!story || typeof story !== "object") return "";
  const s = story as Record<string, unknown>;
  const kit = (s.kit && typeof s.kit === "object" ? s.kit : s) as Record<string, unknown>;
  const beats = Array.isArray(kit.beats) ? (kit.beats as Record<string, unknown>[]).map((b) => `- ${String(b.say ?? b.text ?? "")}`.trim()).join("\n") : "";
  const parts = [
    kit.header ? `Header: ${String(kit.header)}` : "",
    kit.hook ? `Hook: ${String(kit.hook)}` : "",
    kit.angle ? `Angle: ${String(kit.angle)}` : "",
    beats ? `Beats:\n${beats}` : "",
    kit.caption ? `Caption: ${String(kit.caption)}` : "",
  ].filter(Boolean);
  return fence(parts.length ? parts.join("\n\n") : stringifyYaml(kit));
}

const trendKitCollector: Collector = {
  types: ["trend_kit"],
  async collect(ws) {
    const rows = await ws.sql<{ id: string; title: string; url: string; status: string; story: unknown; heat: string | null; published_at: Date | null; first_seen_at: Date }[]>`
      select id, title, url, status, story, heat, published_at, first_seen_at from trends
       where workspace_id = ${ws.id} and story is not null order by first_seen_at desc limit 2000`;
    return rows
      .map((r) => ({
        sourceType: "trend_kit" as const,
        sourceId: r.id,
        title: `Trend kit: ${short(fence(r.title), 120)}`,
        text: kitText(r.story),
        // Built from scraped headlines by a tool-less writer; keep treating it as outside data.
        trust: "untrusted" as const,
        metadata: { trendId: r.id, url: r.url, status: r.status, heat: r.heat === null ? undefined : Number(r.heat) },
        sourceDate: r.published_at ?? r.first_seen_at,
        format: "text" as const,
      }))
      .filter((d) => d.text.trim());
  },
};

export const COLLECTORS: Collector[] = [brandCollector, ownPostsCollector, scriptsCollector, competitorCollector, hooksCollector, postMortemCollector, teardownCollector, trendKitCollector];

/** Source types the workspace indexers produce (dm and lead_note are reserved for later, opt-in indexers). */
export const INDEXED_SOURCE_TYPES: SourceType[] = COLLECTORS.flatMap((c) => c.types);

export type IndexWorkspaceOptions = {
  /** Only these source types (default: all). */
  sources?: string[];
  /** Only these files (workspace-relative or absolute, inside brand/). Skips the database indexers. */
  paths?: string[];
  embedder?: Embedder | null;
};

export type IndexWorkspaceResult = IndexResult & {
  sourceTypes: SourceType[];
  staleDeleted: number;
  skipped?: string;
  /** Requested sources that aren't known source types. */
  unknownSources?: string[];
};

export type LastIndex = { at: string; embedder: string | null; sources: number; chunksWritten: number; embedded: number; warning?: string };

async function saveLastIndex(ws: WorkspaceContext, value: LastIndex): Promise<void> {
  await ws.sql`insert into settings (workspace_id, key, value, updated_at) values (${ws.id}, ${LAST_INDEX_KEY}, ${ws.sql.json(value)}, now())
               on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()`;
}

export async function lastIndex(ws: WorkspaceContext): Promise<LastIndex | null> {
  const [row] = await ws.sql<{ value: LastIndex }[]>`select value from settings where workspace_id = ${ws.id} and key = ${LAST_INDEX_KEY}`;
  return row?.value ?? null;
}

function resolveEmbedder(ws: WorkspaceContext, given: Embedder | null | undefined): { embedder: Embedder | null; warning?: string } {
  if (given !== undefined) return { embedder: given };
  try {
    return { embedder: workspaceEmbedder(ws) };
  } catch (err) {
    return { embedder: null, warning: (err as Error).message };
  }
}

/**
 * Incremental workspace index: gathers every source, skips what hasn't changed (by hash), embeds what's new,
 * and removes chunks whose source is gone. One run at a time per workspace (advisory lock).
 */
export async function indexWorkspace(ws: WorkspaceContext, opts: IndexWorkspaceOptions = {}): Promise<IndexWorkspaceResult> {
  const conn = await ws.sql.reserve();
  const lockKey = `attentionos:knowledge:${ws.id}`;
  try {
    const [lock] = await conn<{ ok: boolean }[]>`select pg_try_advisory_lock(hashtext(${lockKey})) as ok`;
    const empty: IndexWorkspaceResult = { sources: 0, unchanged: 0, updated: 0, chunksWritten: 0, chunksDeleted: 0, embedded: 0, sourceTypes: [], staleDeleted: 0 };
    if (!lock?.ok) return { ...empty, skipped: "Another knowledge index run is already in progress." };
    try {
      const { embedder, warning } = resolveEmbedder(ws, opts.embedder);
      if (opts.paths?.length) {
        const r = await indexPaths(ws, opts.paths, { embedder });
        return { ...r, ...(warning && !r.embedWarning ? { embedWarning: warning } : {}) };
      }
      const wanted = opts.sources?.length ? new Set(opts.sources) : null;
      const unknownSources = wanted ? [...wanted].filter((s) => !(SOURCE_TYPES as readonly string[]).includes(s)) : [];
      const collectors = COLLECTORS.filter((c) => !wanted || c.types.some((t) => wanted.has(t)));
      const docs: SourceDoc[] = [];
      const types: SourceType[] = [];
      for (const c of collectors) {
        const got = await c.collect(ws);
        const keepTypes = c.types.filter((t) => !wanted || wanted.has(t));
        types.push(...keepTypes);
        docs.push(...got.filter((d) => keepTypes.includes(d.sourceType)));
      }
      const r = await indexSources(ws, docs, { embedder });
      const staleDeleted = await deleteStaleSources(ws, types, docs);
      const result: IndexWorkspaceResult = { ...r, sourceTypes: types, staleDeleted, ...(unknownSources.length ? { unknownSources } : {}) };
      if (warning && !result.embedWarning) result.embedWarning = warning;
      if (!wanted) {
        await saveLastIndex(ws, {
          at: ws.now().toISOString(),
          embedder: embedder?.id ?? null,
          sources: r.sources,
          chunksWritten: r.chunksWritten,
          embedded: r.embedded,
          ...(result.embedWarning ? { warning: result.embedWarning } : {}),
        });
      }
      return result;
    } finally {
      await conn`select pg_advisory_unlock(hashtext(${lockKey}))`.catch(() => {});
    }
  } finally {
    conn.release();
  }
}

/** Re-indexes the given Brand Kit files right after an edit; a deleted file's chunks are removed. */
export async function indexPaths(ws: WorkspaceContext, paths: string[], opts: { embedder?: Embedder | null } = {}): Promise<IndexWorkspaceResult> {
  const docs: SourceDoc[] = [];
  let staleDeleted = 0;
  const types = new Set<SourceType>();
  const rejected: string[] = [];
  for (const p of paths) {
    const c = classifyBrandPath(ws, p);
    if (!c) {
      rejected.push(p);
      continue;
    }
    types.add(c.sourceType);
    const doc = brandFileSource(ws, p);
    if (doc) docs.push(doc);
    else staleDeleted += await deleteSource(ws, c.sourceType, c.rel);
  }
  if (rejected.length && !docs.length && !staleDeleted && !types.size) {
    throw new Error(`Only Brand Kit files can be indexed by path (brand/*.md, brand/*.yaml, brand/knowledge/**): ${rejected.join(", ")}`);
  }
  const r = await indexSources(ws, docs, opts);
  return { ...r, sourceTypes: [...types], staleDeleted };
}

/** One file after an edit (`knowledge.index-path`). */
export function indexPath(ws: WorkspaceContext, path: string, opts: { embedder?: Embedder | null } = {}): Promise<IndexWorkspaceResult> {
  return indexPaths(ws, [path], opts);
}

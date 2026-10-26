import { createHash } from "node:crypto";
import type { WorkspaceContext } from "@attentionos/core";
import { chunkDocument, formatForPath, type Chunk, type ChunkFormat } from "./chunk.ts";
import { SOURCE_TYPES, TRUST_LEVELS, type SourceType, type Trust } from "./constants.ts";
import { chunkTokensFor, toVectorLiteral, workspaceEmbedder, type Embedder } from "./embedder.ts";

/** One thing to index: a Brand Kit file, a post, a script, a competitor transcript... */
export type SourceDoc = {
  sourceType: SourceType;
  /** Stable id within its type: a workspace-relative path for files, a row id for database rows. */
  sourceId: string;
  path?: string | null;
  title: string;
  text: string;
  trust: Trust;
  metadata?: Record<string, unknown>;
  /** When the source was made or published (for "since" filters). */
  sourceDate?: Date | string | null;
  /** How to chunk `text`; defaults from the path's extension (markdown otherwise). */
  format?: ChunkFormat;
};

export type IndexOptions = {
  /** Defaults to the workspace's configured embedder. `null` stores chunks without vectors (keyword search only). */
  embedder?: Embedder | null;
};

export type IndexResult = {
  sources: number;
  unchanged: number;
  updated: number;
  chunksWritten: number;
  chunksDeleted: number;
  embedded: number;
  /** Plain-language reason vectors couldn't be made this time (chunks are still stored; keyword search works). */
  embedWarning?: string;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with sorted keys, so the same metadata always hashes the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v instanceof Date ? v.toISOString() : v) ?? "null";
}

const isoOrNull = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function chunkTitle(docTitle: string, heading: string): string {
  if (!heading) return docTitle;
  return docTitle ? `${docTitle} › ${heading}` : heading;
}

/** The text an embedder sees for one chunk: its title line, then the content. */
export const embeddingText = (title: string, content: string) => (title ? `${title}\n\n${content}` : content);

type Prepared = {
  doc: SourceDoc;
  chunks: { title: string; content: string; hash: string }[];
  sourceHash: string;
};

export function prepareSource(doc: SourceDoc, maxTokens: number): Prepared {
  if (!SOURCE_TYPES.includes(doc.sourceType)) throw new Error(`Unknown knowledge source type "${doc.sourceType}"`);
  if (!TRUST_LEVELS.includes(doc.trust)) throw new Error(`Unknown trust level "${doc.trust}"`);
  const raw: Chunk[] = doc.text.trim() ? chunkDocument(doc.text, doc.format ?? formatForPath(doc.path), { maxTokens }) : [];
  const chunks = raw.map((c) => {
    const title = chunkTitle(doc.title, c.heading).slice(0, 300);
    return { title, content: c.content, hash: sha256(`${title}\n\u0000${c.content}`) };
  });
  const sourceHash = sha256(
    stableJson({ chunks: chunks.map((c) => c.hash), trust: doc.trust, path: doc.path ?? null, metadata: doc.metadata ?? {}, date: isoOrNull(doc.sourceDate) }),
  );
  return { doc, chunks, sourceHash };
}

type ExistingRow = { source_type: string; source_id: string; chunk_index: number; content_hash: string; source_hash: string | null; embedding_model: string | null };

const keyOf = (t: string, id: string) => `${t}\u0000${id}`;

/**
 * Indexes many sources in one pass: unchanged sources are skipped without embedding anything, unchanged chunks
 * of a changed source keep their vectors, only new or edited chunks are embedded (in batches), and chunks past
 * the new end of a shortened source are deleted.
 */
export async function indexSources(ws: WorkspaceContext, docs: SourceDoc[], opts: IndexOptions = {}): Promise<IndexResult> {
  let embedder: Embedder | null;
  let embedWarning: string | undefined;
  if (opts.embedder !== undefined) embedder = opts.embedder;
  else {
    try {
      embedder = workspaceEmbedder(ws);
    } catch (err) {
      embedder = null;
      embedWarning = (err as Error).message;
    }
  }
  // Without an embedder we still size chunks for the default local model, so turning it on later re-uses them.
  const maxTokens = chunkTokensFor(embedder ?? { maxInputTokens: 512 });
  const result: IndexResult = { sources: 0, unchanged: 0, updated: 0, chunksWritten: 0, chunksDeleted: 0, embedded: 0 };

  const unique = new Map<string, SourceDoc>();
  for (const d of docs) unique.set(keyOf(d.sourceType, d.sourceId), d);
  const all = [...unique.values()];

  for (let start = 0; start < all.length; start += 200) {
    const group = all.slice(start, start + 200).map((d) => prepareSource(d, maxTokens));
    const existing = await ws.sql<ExistingRow[]>`
      select c.source_type, c.source_id, c.chunk_index, c.content_hash, c.source_hash, c.embedding_model
        from knowledge_chunks c
        join unnest(${group.map((g) => g.doc.sourceType)}::text[], ${group.map((g) => g.doc.sourceId)}::text[]) as k(t, i)
          on c.source_type = k.t and c.source_id = k.i
       where c.workspace_id = ${ws.id}`;
    const bySource = new Map<string, Map<number, ExistingRow>>();
    for (const r of existing) {
      const k = keyOf(r.source_type, r.source_id);
      if (!bySource.has(k)) bySource.set(k, new Map());
      bySource.get(k)!.set(r.chunk_index, r);
    }

    type Write = { g: Prepared; index: number; title: string; content: string; hash: string; embed: boolean };
    const writes: Write[] = [];
    const deletes: { t: string; i: string; from: number }[] = [];
    for (const g of group) {
      result.sources += 1;
      const rows = bySource.get(keyOf(g.doc.sourceType, g.doc.sourceId)) ?? new Map<number, ExistingRow>();
      const current = (r: ExistingRow | undefined) => Boolean(r && (!embedder || r.embedding_model === embedder.id));
      const unchanged =
        rows.size === g.chunks.length &&
        g.chunks.every((c, i) => {
          const r = rows.get(i);
          return r && r.content_hash === c.hash && r.source_hash === g.sourceHash && current(r);
        });
      if (unchanged) {
        result.unchanged += 1;
        continue;
      }
      result.updated += 1;
      g.chunks.forEach((c, i) => {
        const r = rows.get(i);
        const sameText = r?.content_hash === c.hash;
        if (sameText && r?.source_hash === g.sourceHash && current(r)) return;
        writes.push({ g, index: i, ...c, embed: Boolean(embedder) && !(sameText && current(r)) });
      });
      if ([...rows.keys()].some((i) => i >= g.chunks.length)) deletes.push({ t: g.doc.sourceType, i: g.doc.sourceId, from: g.chunks.length });
    }

    // Embed what changed, all at once (the local embedder pays its start-up cost per call, not per chunk).
    const vectors = new Map<Write, string>();
    const toEmbed = writes.filter((w) => w.embed);
    if (embedder && toEmbed.length) {
      try {
        const vecs = await embedder.embed(toEmbed.map((w) => embeddingText(w.title, w.content)), "document");
        if (vecs.length !== toEmbed.length) throw new Error(`the embedder returned ${vecs.length} vectors for ${toEmbed.length} passages`);
        toEmbed.forEach((w, i) => vectors.set(w, toVectorLiteral(vecs[i]!)));
        result.embedded += toEmbed.length;
      } catch (err) {
        embedWarning ??= `${(err as Error).message}${(err as { fix?: string }).fix ? ` ${(err as { fix?: string }).fix}` : ""}`;
        ws.log.warn("knowledge: embedding failed; stored chunks without vectors", { error: (err as Error).message });
      }
    }

    if (writes.length || deletes.length) {
      await ws.sql.begin(async (tx) => {
        for (let i = 0; i < writes.length; i += 500) {
          const batch = writes.slice(i, i + 500);
          await tx`
            insert into knowledge_chunks (workspace_id, source_type, source_id, path, title, chunk_index, content, content_hash,
                                          source_hash, trust, metadata, source_date, embedding, embedding_model)
            select ${ws.id}, u.t, u.i, u.p, u.title, u.idx, u.content, u.hash, u.shash, u.trust, u.meta::jsonb, u.d::timestamptz,
                   u.emb::vector, case when u.emb is null then null else u.model end
              from unnest(
                ${batch.map((w) => w.g.doc.sourceType)}::text[], ${batch.map((w) => w.g.doc.sourceId)}::text[],
                ${batch.map((w) => w.g.doc.path ?? null)}::text[], ${batch.map((w) => w.title)}::text[],
                ${batch.map((w) => w.index)}::int[], ${batch.map((w) => w.content)}::text[], ${batch.map((w) => w.hash)}::text[],
                ${batch.map((w) => w.g.sourceHash)}::text[], ${batch.map((w) => w.g.doc.trust)}::text[],
                ${batch.map((w) => JSON.stringify(w.g.doc.metadata ?? {}))}::text[], ${batch.map((w) => isoOrNull(w.g.doc.sourceDate))}::text[],
                ${batch.map((w) => vectors.get(w) ?? null)}::text[], ${batch.map(() => embedder?.id ?? null)}::text[]
              ) as u(t, i, p, title, idx, content, hash, shash, trust, meta, d, emb, model)
            on conflict (workspace_id, source_type, source_id, chunk_index) do update set
              path = excluded.path, title = excluded.title, content = excluded.content, trust = excluded.trust,
              metadata = excluded.metadata, source_date = excluded.source_date, source_hash = excluded.source_hash,
              embedding = case when excluded.embedding is not null then excluded.embedding
                               when knowledge_chunks.content_hash = excluded.content_hash then knowledge_chunks.embedding end,
              embedding_model = case when excluded.embedding is not null then excluded.embedding_model
                                     when knowledge_chunks.content_hash = excluded.content_hash then knowledge_chunks.embedding_model end,
              content_hash = excluded.content_hash,
              updated_at = now()`;
          result.chunksWritten += batch.length;
        }
        for (const d of deletes) {
          const gone = await tx`delete from knowledge_chunks where workspace_id = ${ws.id} and source_type = ${d.t} and source_id = ${d.i} and chunk_index >= ${d.from}`;
          result.chunksDeleted += gone.count;
        }
      });
    }
  }
  if (embedWarning) result.embedWarning = embedWarning;
  return result;
}

/** Indexes (or re-indexes) one source. Unchanged content is detected by hash and not embedded again. */
export function indexSource(ws: WorkspaceContext, doc: SourceDoc, opts: IndexOptions = {}): Promise<IndexResult> {
  return indexSources(ws, [doc], opts);
}

/** Removes every chunk of one source (a deleted file, a deleted row). */
export async function deleteSource(ws: WorkspaceContext, sourceType: SourceType, sourceId: string): Promise<number> {
  const r = await ws.sql`delete from knowledge_chunks where workspace_id = ${ws.id} and source_type = ${sourceType} and source_id = ${sourceId}`;
  return r.count;
}

/** After a full scan of some source types: removes chunks of those types whose source no longer exists. */
export async function deleteStaleSources(ws: WorkspaceContext, sourceTypes: SourceType[], keep: { sourceType: SourceType; sourceId: string }[]): Promise<number> {
  if (!sourceTypes.length) return 0;
  const r = await ws.sql`
    delete from knowledge_chunks c
     where c.workspace_id = ${ws.id}
       and c.source_type = any(${sourceTypes}::text[])
       and not exists (
         select 1 from unnest(${keep.map((k) => k.sourceType)}::text[], ${keep.map((k) => k.sourceId)}::text[]) as k(t, i)
          where k.t = c.source_type and k.i = c.source_id)`;
  return r.count;
}

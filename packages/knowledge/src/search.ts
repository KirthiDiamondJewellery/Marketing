import type { Sql, WorkspaceContext } from "@attentionos/core";
import { INDEXED_DIMS, type SourceType, type Trust } from "./constants.ts";
import { toVectorLiteral, workspaceEmbedder, type Embedder } from "./embedder.ts";
import { reciprocalRankFusion } from "./rrf.ts";

export type SearchOptions = {
  query: string;
  /** Results to return (default 8). */
  k?: number;
  sourceTypes?: SourceType[];
  trust?: Trust;
  /** Only sources made or published (else indexed) on or after this time. */
  since?: Date | string;
  /** At most this many chunks from one source (default 3), so one long document can't crowd out the rest. */
  perSource?: number;
  /** Defaults to the workspace's configured embedder. `null` = keyword search only. */
  embedder?: Embedder | null;
  /** Candidates taken from each ranking before fusion (default max(4k, 40)). */
  candidates?: number;
};

export type SearchHit = {
  content: string;
  title: string;
  path: string | null;
  sourceType: SourceType;
  sourceId: string;
  chunkIndex: number;
  trust: Trust;
  /** Reciprocal-rank-fusion score: higher is better; comparable within one search only. */
  score: number;
  /** Which rankings found it: meaning (vector), keywords (full text) or both. */
  matchedBy: "both" | "meaning" | "keywords";
  metadata: Record<string, unknown>;
};

export type SearchResult = {
  hits: SearchHit[];
  /** "hybrid" when both rankings ran; "keyword" when vectors weren't available. */
  mode: "hybrid" | "keyword";
  /** Plain-language note when search ran with less than it could (e.g. vectors unavailable). */
  warning?: string;
};

/** Words too common to help a keyword match (the full-text index uses the language-neutral "simple" config). */
const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your".split(" "),
);

/** OR-query of the meaningful words (plus naive singulars), safe to pass to to_tsquery('simple', ...). */
export function keywordQuery(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const terms = new Set<string>();
  for (const w of words) {
    terms.add(w);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) terms.add(w.slice(0, -1));
  }
  const list = [...terms].slice(0, 32);
  return list.length ? list.map((t) => `'${t}'`).join(" | ") : null;
}

type Filter = { clause: string; params: unknown[] };

function filters(ws: WorkspaceContext, opts: SearchOptions, firstParam: number): Filter {
  const params: unknown[] = [ws.id];
  const parts = [`workspace_id = $${firstParam}`];
  const next = (v: unknown) => {
    params.push(v);
    return `$${firstParam + params.length - 1}`;
  };
  if (opts.sourceTypes?.length) parts.push(`source_type = any(${next(opts.sourceTypes)}::text[])`);
  if (opts.trust) parts.push(`trust = ${next(opts.trust)}`);
  if (opts.since) {
    const d = opts.since instanceof Date ? opts.since : new Date(opts.since);
    if (!Number.isNaN(d.getTime())) parts.push(`coalesce(source_date, updated_at) >= ${next(d.toISOString())}::timestamptz`);
  }
  return { clause: parts.join(" and "), params };
}

const iterativeScan = new WeakMap<Sql, Promise<boolean>>();

/** pgvector 0.8+ can keep scanning the HNSW graph until enough rows pass the filters. */
function supportsIterativeScan(sql: Sql): Promise<boolean> {
  let p = iterativeScan.get(sql);
  if (!p) {
    p = sql<{ v: string | null }[]>`select extversion as v from pg_extension where extname = 'vector'`
      .then(([r]) => {
        const [maj, min] = (r?.v ?? "0.0").split(".").map(Number);
        return maj! > 0 || min! >= 8;
      })
      .catch(() => false);
    iterativeScan.set(sql, p);
  }
  return p;
}

async function vectorRanking(ws: WorkspaceContext, embedderId: string, vector: number[], opts: SearchOptions, limit: number): Promise<number[]> {
  const dim = vector.length;
  if (!Number.isInteger(dim) || dim < 1 || dim > 16_000) return [];
  const f = filters(ws, opts, 3);
  // A cast to the exact size lets Postgres use the partial HNSW index for that size.
  const cast = (INDEXED_DIMS as readonly number[]).includes(dim) ? `::vector(${dim})` : "";
  const text = `
    select id from (
      select id, embedding${cast} <=> $1::vector${cast} as distance
        from knowledge_chunks
       where ${f.clause} and embedding_model = $2 and embedding_dim = ${dim}
       order by embedding${cast} <=> $1::vector${cast}
       limit ${limit}
    ) v order by distance`;
  const params = [toVectorLiteral(vector), embedderId, ...f.params];
  const iterative = await supportsIterativeScan(ws.sql);
  const rows = await ws.sql.begin(async (tx) => {
    if (iterative) await tx.unsafe("set local hnsw.iterative_scan = relaxed_order");
    await tx.unsafe(`set local hnsw.ef_search = ${Math.max(40, Math.min(1000, limit * 2))}`);
    return tx.unsafe<{ id: string }[]>(text, params as never[]);
  });
  return rows.map((r) => Number(r.id));
}

async function keywordRanking(ws: WorkspaceContext, tsquery: string, opts: SearchOptions, limit: number): Promise<number[]> {
  const f = filters(ws, opts, 2);
  const rows = await ws.sql.unsafe<{ id: string }[]>(
    `select id from knowledge_chunks, to_tsquery('simple', $1) q
      where ${f.clause} and tsv @@ q
      order by ts_rank(tsv, q) desc, id
      limit ${limit}`,
    [tsquery, ...f.params] as never[],
  );
  return rows.map((r) => Number(r.id));
}

const queryCache = new Map<string, number[]>();

async function embedQuery(embedder: Embedder, query: string): Promise<number[]> {
  const key = `${embedder.id}\u0000${query}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const [v] = await embedder.embed([query], "query");
  if (!v) throw new Error("the embedder returned no vector");
  queryCache.set(key, v);
  if (queryCache.size > 128) queryCache.delete(queryCache.keys().next().value!);
  return v;
}

/**
 * Hybrid search: top-N by meaning (cosine distance over this embedder's vectors) and top-N by keywords
 * (full-text `ts_rank`), fused with reciprocal rank fusion. Falls back to keywords alone when the embedder
 * can't run, and says so in `warning`.
 */
export async function searchKnowledge(ws: WorkspaceContext, opts: SearchOptions): Promise<SearchResult> {
  const query = opts.query.trim();
  if (!query) return { hits: [], mode: "keyword" };
  const k = Math.max(1, Math.min(50, opts.k ?? 8));
  const perSource = Math.max(1, opts.perSource ?? 3);
  const limit = Math.max(1, Math.min(200, opts.candidates ?? Math.max(4 * k, 40)));

  let warning: string | undefined;
  let embedder: Embedder | null = null;
  if (opts.embedder !== undefined) embedder = opts.embedder;
  else {
    try {
      embedder = workspaceEmbedder(ws);
    } catch (err) {
      warning = (err as Error).message;
    }
  }

  let vectorIds: number[] = [];
  let mode: SearchResult["mode"] = "keyword";
  if (embedder) {
    try {
      const v = await embedQuery(embedder, query);
      vectorIds = await vectorRanking(ws, embedder.id, v, opts, limit);
      mode = "hybrid";
    } catch (err) {
      const fix = (err as { fix?: string }).fix;
      warning = `Searched by keywords only: ${(err as Error).message}${fix ? ` ${fix}` : ""}`;
    }
  }
  const tsq = keywordQuery(query);
  const keywordIds = tsq ? await keywordRanking(ws, tsq, opts, limit) : [];

  const fused = reciprocalRankFusion([vectorIds, keywordIds]);
  if (!fused.length) return { hits: [], mode, ...(warning ? { warning } : {}) };

  const ids = fused.slice(0, Math.min(fused.length, k * perSource + k * 2)).map((f) => f.id);
  const rows = await ws.sql<{
    id: string; content: string; title: string; path: string | null; source_type: SourceType; source_id: string; chunk_index: number; trust: Trust; metadata: Record<string, unknown>;
  }[]>`select id, content, title, path, source_type, source_id, chunk_index, trust, metadata
         from knowledge_chunks where workspace_id = ${ws.id} and id = any(${ids}::bigint[])`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));

  const hits: SearchHit[] = [];
  const perSourceCount = new Map<string, number>();
  for (const f of fused) {
    const r = byId.get(f.id);
    if (!r) continue;
    const key = `${r.source_type}\u0000${r.source_id}`;
    const n = perSourceCount.get(key) ?? 0;
    if (n >= perSource) continue;
    perSourceCount.set(key, n + 1);
    const [vr, kr] = f.ranks;
    hits.push({
      content: r.content,
      title: r.title,
      path: r.path,
      sourceType: r.source_type,
      sourceId: r.source_id,
      chunkIndex: r.chunk_index,
      trust: r.trust,
      score: Math.round(f.score * 1e5) / 1e5,
      matchedBy: vr && kr ? "both" : vr ? "meaning" : "keywords",
      metadata: r.metadata ?? {},
    });
    if (hits.length >= k) break;
  }
  return { hits, mode, ...(warning ? { warning } : {}) };
}

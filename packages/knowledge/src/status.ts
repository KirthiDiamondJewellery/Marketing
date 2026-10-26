import type { WorkspaceContext } from "@attentionos/core";
import type { SourceType, Trust } from "./constants.ts";
import { workspaceEmbedder } from "./embedder.ts";
import { lastIndex, type LastIndex } from "./indexers.ts";

export type KnowledgeStatus = {
  /** The embedder searches use now ("local:BAAI/bge-small-en-v1.5"), or null with `embedderProblem`. */
  embedder: string | null;
  embedderProblem?: string;
  totals: { sources: number; chunks: number; withVectors: number; needVectors: number };
  bySourceType: { sourceType: SourceType; trust: Trust; sources: number; chunks: number; withVectors: number; lastIndexedAt: string | null }[];
  /** Vectors stored per model; more than one means a re-embed is in progress (or failed). */
  models: { model: string; dim: number | null; chunks: number }[];
  lastRun: LastIndex | null;
};

export async function knowledgeStatus(ws: WorkspaceContext): Promise<KnowledgeStatus> {
  let embedder: string | null = null;
  let embedderProblem: string | undefined;
  try {
    embedder = workspaceEmbedder(ws).id;
  } catch (err) {
    embedderProblem = (err as Error).message;
  }
  const rows = await ws.sql<{ source_type: SourceType; trust: Trust; sources: string; chunks: string; with_vectors: string; current: string; last: Date | null }[]>`
    select source_type, trust, count(distinct source_id) as sources, count(*) as chunks,
           count(embedding) as with_vectors,
           count(*) filter (where embedding_model is not distinct from ${embedder}) as current,
           max(updated_at) as last
      from knowledge_chunks where workspace_id = ${ws.id}
     group by source_type, trust order by source_type, trust`;
  const models = await ws.sql<{ model: string; dim: number | null; chunks: string }[]>`
    select embedding_model as model, max(embedding_dim) as dim, count(*) as chunks
      from knowledge_chunks where workspace_id = ${ws.id} and embedding_model is not null
     group by embedding_model order by count(*) desc`;
  const n = (s: string) => Number(s);
  return {
    embedder,
    ...(embedderProblem ? { embedderProblem } : {}),
    totals: {
      sources: rows.reduce((a, r) => a + n(r.sources), 0),
      chunks: rows.reduce((a, r) => a + n(r.chunks), 0),
      withVectors: rows.reduce((a, r) => a + n(r.with_vectors), 0),
      needVectors: embedder ? rows.reduce((a, r) => a + n(r.chunks) - n(r.current), 0) : 0,
    },
    bySourceType: rows.map((r) => ({
      sourceType: r.source_type,
      trust: r.trust,
      sources: n(r.sources),
      chunks: n(r.chunks),
      withVectors: n(r.with_vectors),
      lastIndexedAt: r.last ? r.last.toISOString() : null,
    })),
    models: models.map((m) => ({ model: m.model, dim: m.dim, chunks: n(m.chunks) })),
    lastRun: await lastIndex(ws),
  };
}

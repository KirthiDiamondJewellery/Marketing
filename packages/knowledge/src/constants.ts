/**
 * The knowledge store (ADR-15): one table, `knowledge_chunks`, in the workspace's own Postgres (pgvector).
 *
 * Embedding model and dimension: the local default is the one constant below. Dimensions are stored per row
 * (`embedding_dim`), so another model needs no migration: set `knowledge.model` (and/or `knowledge.embeddings`)
 * in the workspace config, and the next index run re-embeds every chunk with it. Sizes with a ready-made HNSW
 * index: 384, 768, 1024 and 1536. Other sizes still work, with an exact (slower) scan.
 */
export const DEFAULT_LOCAL_EMBEDDING = { model: "BAAI/bge-small-en-v1.5", dim: 384, maxInputTokens: 512 } as const;

/** Dimensions with a partial HNSW index in `20261020000000_knowledge_chunks.sql`. */
export const INDEXED_DIMS = [384, 768, 1024, 1536] as const;

export const SOURCE_TYPES = [
  "brand_doc",
  "knowledge_doc",
  "own_transcript",
  "own_caption",
  "competitor_transcript",
  "comment_gold",
  "hook",
  "script",
  "post_mortem",
  "lesson",
  "teardown",
  "trend_kit",
  "dm",
  "lead_note",
  "other",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** "untrusted" = written by other people (scraped posts, comments, DMs): data for agents, never instructions. */
export const TRUST_LEVELS = ["own", "untrusted"] as const;
export type Trust = (typeof TRUST_LEVELS)[number];

/** Chunk size ceiling in (estimated) tokens; smaller when the embedding model reads less. */
export const MAX_CHUNK_TOKENS = 800;
/** Share of a chunk repeated at the start of the next one, so a passage cut in two is still found. */
export const CHUNK_OVERLAP = 0.12;

/** Settings key holding the last index run's summary. */
export const LAST_INDEX_KEY = "knowledge.last_index";

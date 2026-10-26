import { mediaPy, MediaPyError, type MediaPyOptions } from "@attentionos/media";
import type { WorkspaceContext } from "@attentionos/core";
import { DEFAULT_LOCAL_EMBEDDING, MAX_CHUNK_TOKENS } from "./constants.ts";

/**
 * Embedders turn text into vectors. The default runs on this machine (media-py + fastembed, no key);
 * OpenAI and Voyage are optional and use plain HTTPS with the workspace's own key (no vendor SDK).
 */

export type EmbedKind = "document" | "query";

export interface Embedder {
  /** Stored in `knowledge_chunks.embedding_model`: "<provider>:<model>". Vectors from different ids never mix. */
  readonly id: string;
  readonly provider: "local" | "openai" | "voyage" | (string & {});
  readonly model: string;
  /** Expected vector size when known up front. */
  readonly dim: number | null;
  /** The longest input the model reads, in tokens. Chunks are sized to fit. */
  readonly maxInputTokens: number;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export class EmbedderError extends Error {
  constructor(
    public readonly code: "unavailable" | "auth" | "rate_limited" | "bad_response" | "upstream",
    message: string,
    public readonly fix?: string,
  ) {
    super(message);
    this.name = "EmbedderError";
  }
}

/** Chunk size for an embedder: up to 800 tokens, but never more than the model reads (minus room for the title). */
export function chunkTokensFor(embedder: Pick<Embedder, "maxInputTokens">): number {
  return Math.max(200, Math.min(MAX_CHUNK_TOKENS, embedder.maxInputTokens - 64));
}

const KNOWN_LOCAL_DIMS: Record<string, number> = {
  [DEFAULT_LOCAL_EMBEDDING.model]: DEFAULT_LOCAL_EMBEDDING.dim,
  "BAAI/bge-base-en-v1.5": 768,
  "sentence-transformers/all-MiniLM-L6-v2": 384,
  "nomic-ai/nomic-embed-text-v1.5": 768,
};

type MediaPyRunner = typeof mediaPy;

/** Local embeddings through media-py's `embed` command (fastembed, ONNX on CPU). */
export function localEmbedder(opts: { model?: string; batch?: number; run?: MediaPyRunner; mediaPyOptions?: MediaPyOptions } = {}): Embedder {
  const model = opts.model ?? DEFAULT_LOCAL_EMBEDDING.model;
  const batch = opts.batch ?? 256;
  const run = opts.run ?? mediaPy;
  return {
    id: `local:${model}`,
    provider: "local",
    model,
    dim: KNOWN_LOCAL_DIMS[model] ?? null,
    maxInputTokens: model.startsWith("nomic-ai/") ? 2048 : 512,
    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batch) {
        try {
          const r = await run<{ vectors: number[][] }>("embed", { model, texts: texts.slice(i, i + batch), kind }, { extras: ["embed"], ...opts.mediaPyOptions });
          out.push(...r.vectors);
        } catch (err) {
          if (err instanceof MediaPyError) throw new EmbedderError("unavailable", `Local embeddings didn't run: ${err.message}`, err.fix);
          throw err;
        }
      }
      return out;
    },
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

type HttpEmbedderOptions = { apiKey: string; model?: string; fetch?: FetchLike; batch?: number; timeoutMs?: number };

async function postJson(fetchImpl: FetchLike, provider: string, url: string, apiKey: string, body: unknown, timeoutMs: number, keyName: string): Promise<unknown> {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EmbedderError("upstream", `${provider} embeddings couldn't be reached: ${(err as Error).message}`, "Check the internet connection, or switch knowledge.embeddings to \"local\".");
  }
  if (res.status === 401 || res.status === 403) throw new EmbedderError("auth", `${provider} rejected the API key.`, `Check ${keyName} in .env.`);
  if (res.status === 429) throw new EmbedderError("rate_limited", `${provider} is rate limiting embeddings right now.`, "Try again in a minute.");
  if (!res.ok) throw new EmbedderError("upstream", `${provider} embeddings failed (HTTP ${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.json();
}

function vectorsFrom(provider: string, json: unknown, expected: number): number[][] {
  const data = (json as { data?: { index?: number; embedding?: unknown }[] }).data;
  if (!Array.isArray(data) || data.length !== expected) throw new EmbedderError("bad_response", `${provider} returned ${Array.isArray(data) ? data.length : "no"} vectors for ${expected} texts.`);
  return [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => {
      if (!Array.isArray(d.embedding) || !d.embedding.every((x) => typeof x === "number")) throw new EmbedderError("bad_response", `${provider} returned a malformed vector.`);
      return d.embedding as number[];
    });
}

/** OpenAI embeddings (OPENAI_API_KEY). Large models are shortened to 1536 dimensions so the HNSW index applies. */
export function openaiEmbedder(opts: HttpEmbedderOptions): Embedder {
  const model = opts.model ?? "text-embedding-3-small";
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const batch = opts.batch ?? 128;
  const shorten = model === "text-embedding-3-large";
  return {
    id: `openai:${model}${shorten ? "@1536" : ""}`,
    provider: "openai",
    model,
    dim: 1536,
    maxInputTokens: 8191,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const slice = texts.slice(i, i + batch).map((t) => t || " ");
        const json = await postJson(fetchImpl, "OpenAI", "https://api.openai.com/v1/embeddings", opts.apiKey, { model, input: slice, ...(shorten ? { dimensions: 1536 } : {}) }, opts.timeoutMs ?? 60_000, "OPENAI_API_KEY");
        out.push(...vectorsFrom("OpenAI", json, slice.length));
      }
      return out;
    },
  };
}

/** Voyage AI embeddings (VOYAGE_API_KEY), with separate query and document modes. */
export function voyageEmbedder(opts: HttpEmbedderOptions): Embedder {
  const model = opts.model ?? "voyage-3.5";
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const batch = opts.batch ?? 128;
  return {
    id: `voyage:${model}`,
    provider: "voyage",
    model,
    dim: /^voyage-3/.test(model) ? 1024 : null,
    maxInputTokens: 32_000,
    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const slice = texts.slice(i, i + batch).map((t) => t || " ");
        const json = await postJson(fetchImpl, "Voyage", "https://api.voyageai.com/v1/embeddings", opts.apiKey, { model, input: slice, input_type: kind }, opts.timeoutMs ?? 60_000, "VOYAGE_API_KEY");
        out.push(...vectorsFrom("Voyage", json, slice.length));
      }
      return out;
    },
  };
}

const overrides = new WeakMap<WorkspaceContext, Embedder>();

/** Pins an embedder for one workspace context (tests, or a host that builds its own). */
export function setWorkspaceEmbedder(ws: WorkspaceContext, embedder: Embedder | null): void {
  if (embedder) overrides.set(ws, embedder);
  else overrides.delete(ws);
}

/** The embedder the workspace config asks for (`knowledge.embeddings`, `knowledge.model`). */
export function workspaceEmbedder(ws: WorkspaceContext): Embedder {
  const pinned = overrides.get(ws);
  if (pinned) return pinned;
  const cfg = ws.config.knowledge ?? { embeddings: "local" as const };
  if (cfg.embeddings === "openai") {
    const apiKey = ws.secret("OPENAI_API_KEY");
    if (!apiKey) throw new EmbedderError("auth", "knowledge.embeddings is \"openai\" but OPENAI_API_KEY is not set.", "Add OPENAI_API_KEY to .env, or set knowledge.embeddings to \"local\".");
    return openaiEmbedder({ apiKey, model: cfg.model });
  }
  if (cfg.embeddings === "voyage") {
    const apiKey = ws.secret("VOYAGE_API_KEY");
    if (!apiKey) throw new EmbedderError("auth", "knowledge.embeddings is \"voyage\" but VOYAGE_API_KEY is not set.", "Add VOYAGE_API_KEY to .env, or set knowledge.embeddings to \"local\".");
    return voyageEmbedder({ apiKey, model: cfg.model });
  }
  return localEmbedder({ model: cfg.model });
}

/** Postgres literal for a vector: "[0.1,0.2,...]". Rejects NaN/Infinity, which pgvector refuses. */
export function toVectorLiteral(v: number[]): string {
  if (!v.length || !v.every(Number.isFinite)) throw new EmbedderError("bad_response", "An embedding contained an invalid number.");
  return `[${v.join(",")}]`;
}

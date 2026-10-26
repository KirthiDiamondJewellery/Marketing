import { createHash } from "node:crypto";
import type { Embedder } from "./embedder.ts";

/**
 * Deterministic embedder for tests: a hashed bag of words (plus naive singulars), L2-normalised. Texts that
 * share words land close together, so vector ranking is meaningful without a model or network.
 */
export function fakeEmbedder(opts: { dim?: number; id?: string; fail?: () => Error | null } = {}): Embedder & { calls: { texts: string[]; kind: string }[] } {
  const dim = opts.dim ?? 384;
  const calls: { texts: string[]; kind: string }[] = [];
  return {
    id: opts.id ?? `fake:bow-${dim}`,
    provider: "fake",
    model: `bow-${dim}`,
    dim,
    maxInputTokens: 512,
    calls,
    async embed(texts, kind) {
      const err = opts.fail?.();
      if (err) throw err;
      calls.push({ texts, kind });
      return texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (let w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
          if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
          const h = createHash("sha256").update(w).digest();
          v[h.readUInt32LE(0) % dim]! += 1;
          v[h.readUInt32LE(4) % dim]! += 0.5;
        }
        const norm = Math.hypot(...v);
        return norm === 0 ? v.map(() => 1 / Math.sqrt(dim)) : v.map((x) => x / norm);
      });
    },
  };
}

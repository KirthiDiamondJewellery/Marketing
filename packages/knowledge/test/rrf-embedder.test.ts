import { describe, expect, it } from "vitest";
import { MediaPyError } from "@attentionos/media";
import { chunkTokensFor, EmbedderError, localEmbedder, openaiEmbedder, toVectorLiteral, voyageEmbedder } from "../src/embedder.ts";
import { reciprocalRankFusion } from "../src/rrf.ts";
import { keywordQuery } from "../src/search.ts";

describe("reciprocal rank fusion", () => {
  it("rewards items both lists agree on", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "a", "d"]]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused[0]!.ranks).toEqual([1, 2]);
    expect(fused.find((f) => f.id === "d")!.ranks).toEqual([null, 3]);
  });

  it("works with one empty list and counts duplicates once", () => {
    const fused = reciprocalRankFusion([[], [1, 2, 1]], 10);
    expect(fused.map((f) => [f.id, f.score])).toEqual([[1, 1 / 11], [2, 1 / 12]]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("breaks ties deterministically by best rank", () => {
    const fused = reciprocalRankFusion([["x", "y"], ["y", "x"]]);
    expect(fused[0]!.score).toBe(fused[1]!.score);
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
  });
});

describe("keyword query", () => {
  it("drops stopwords, adds naive singulars and stays tsquery-safe", () => {
    expect(keywordQuery("How do I price kitchens?")).toBe("'price' | 'kitchens' | 'kitchen'");
    expect(keywordQuery("the and of")).toBeNull();
    expect(keywordQuery("it's O'Brien's & | ! (permits)")).toBe("'brien' | 'permits' | 'permit'");
  });
});

type Call = { url: string; body: Record<string, unknown>; auth: string };

function fakeFetch(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const call = { url, body: JSON.parse(init.body) as Record<string, unknown>, auth: init.headers.authorization ?? "" };
    calls.push(call);
    const r = handler(call);
    return { ok: r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

const vectorsFor = (input: unknown[], dim: number) => ({ data: input.map((_, i) => ({ index: i, embedding: Array.from({ length: dim }, (_, j) => (i + 1) * 0.001 * (j + 1)) })).reverse() });

describe("API embedders (recorded shapes, no network)", () => {
  it("OpenAI: batches, keeps order by index, and shortens large models to 1536", async () => {
    const { fetch, calls } = fakeFetch((c) => ({ status: 200, body: vectorsFor(c.body.input as unknown[], 1536) }));
    const e = openaiEmbedder({ apiKey: "sk-test", fetch, batch: 2 });
    const vecs = await e.embed(["a", "b", "c"], "document");
    expect(calls.map((c) => (c.body.input as string[]).length)).toEqual([2, 1]);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]!.auth).toBe("Bearer sk-test");
    expect(vecs.map((v) => v[0])).toEqual([0.001, 0.002, 0.001]);
    expect(e.id).toBe("openai:text-embedding-3-small");
    const large = openaiEmbedder({ apiKey: "k", model: "text-embedding-3-large", fetch });
    await large.embed(["x"], "query");
    expect(calls.at(-1)!.body.dimensions).toBe(1536);
    expect(large.id).toBe("openai:text-embedding-3-large@1536");
  });

  it("Voyage: sends the query/document mode", async () => {
    const { fetch, calls } = fakeFetch((c) => ({ status: 200, body: vectorsFor(c.body.input as unknown[], 1024) }));
    const e = voyageEmbedder({ apiKey: "pa-test", fetch });
    await e.embed(["what does it cost"], "query");
    expect(calls[0]!.body).toMatchObject({ model: "voyage-3.5", input_type: "query" });
    expect(e.dim).toBe(1024);
  });

  it("turns HTTP failures into plain errors", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { error: "bad key" } }));
    await expect(openaiEmbedder({ apiKey: "bad", fetch }).embed(["a"], "document")).rejects.toMatchObject({ code: "auth" });
    const short = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    await expect(voyageEmbedder({ apiKey: "k", fetch: short.fetch }).embed(["a"], "document")).rejects.toBeInstanceOf(EmbedderError);
  });
});

describe("local embedder", () => {
  it("calls media-py embed in batches with the embed extra", async () => {
    const calls: { cmd: string; input: { texts: string[]; kind: string; model: string }; extras?: string[] }[] = [];
    const run = (async (cmd: string, input: unknown, opts: { extras?: string[] }) => {
      const i = input as { texts: string[]; kind: string; model: string };
      calls.push({ cmd, input: i, extras: opts.extras });
      return { model: i.model, dim: 3, vectors: i.texts.map(() => [1, 0, 0]) };
    }) as never;
    const e = localEmbedder({ run, batch: 2 });
    const out = await e.embed(["a", "b", "c"], "query");
    expect(out).toHaveLength(3);
    expect(calls.map((c) => [c.cmd, c.input.texts.length, c.input.kind, c.extras])).toEqual([["embed", 2, "query", ["embed"]], ["embed", 1, "query", ["embed"]]]);
    expect(e.id).toBe("local:BAAI/bge-small-en-v1.5");
    expect(e.dim).toBe(384);
    expect(chunkTokensFor(e)).toBe(448);
    expect(chunkTokensFor(openaiEmbedder({ apiKey: "k" }))).toBe(800);
  });

  it("reports a missing sidecar as unavailable with its fix", async () => {
    const run = (async () => {
      throw new MediaPyError("uv_missing", "uv (the Python runner) is not installed.", "Install uv");
    }) as never;
    await expect(localEmbedder({ run }).embed(["a"], "document")).rejects.toMatchObject({ code: "unavailable", fix: "Install uv" });
  });

  it("formats vectors for Postgres and rejects NaN", () => {
    expect(toVectorLiteral([0.5, -1, 2e-7])).toBe("[0.5,-1,2e-7]");
    expect(() => toVectorLiteral([Number.NaN])).toThrow(EmbedderError);
  });
});

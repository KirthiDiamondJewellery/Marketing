import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CHUNK_OVERLAP, MAX_CHUNK_TOKENS } from "./constants.ts";

/**
 * Chunking: markdown by heading sections and paragraphs (~800 tokens, smaller when the embedding model reads
 * less, with a little overlap inside a section), YAML one item per chunk, plain text by paragraphs.
 * Pure functions: same input, same chunks, so unchanged files hash the same and are never re-embedded.
 */

export type Chunk = {
  /** Heading path inside the document ("Pricing › Packages"), or the YAML item label; "" when there is none. */
  heading: string;
  content: string;
};

export type ChunkOptions = { maxTokens?: number; overlap?: number };

/** Rough token count for English prose with a WordPiece/BPE tokenizer; errs on the high side. */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(text.length / 4), Math.ceil(words * 1.3));
}

type Block = { heading: string; text: string; sectionId: number; startsSection: boolean };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

function optsOf(opts: ChunkOptions): { max: number; overlapTokens: number } {
  const max = Math.max(50, Math.floor(opts.maxTokens ?? MAX_CHUNK_TOKENS));
  return { max, overlapTokens: Math.floor(max * (opts.overlap ?? CHUNK_OVERLAP)) };
}

/** Splits markdown into blocks (paragraphs, lists, code fences) tagged with their heading path. */
function markdownBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const stack: { level: number; title: string }[] = [];
  let section = 0;
  let startsSection = true;
  let buf: string[] = [];
  let inFence = false;
  const heading = () => stack.map((s) => s.title).join(" › ");
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    blocks.push({ heading: heading(), text: body, sectionId: section, startsSection });
    startsSection = false;
  };
  // Front matter stays one block at the top.
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      buf = lines.splice(0, end + 1);
      flush();
    }
  }
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!inFence) flush();
      inFence = !inFence;
      buf.push(line);
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      // A heading directly under another heading travels with the text below both.
      if (!buf.every((l) => HEADING.test(l))) flush();
      const level = h[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: h[2]!.replace(/[*_`]/g, "").trim() });
      section += 1;
      startsSection = true;
      buf.push(line);
      continue;
    }
    if (!line.trim()) {
      // Heading lines alone aren't a block: keep them with the paragraph that follows.
      if (buf.length && buf.every((l) => HEADING.test(l))) continue;
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=\S)|\n+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

/** Breaks one oversized piece into pieces that each fit `max` tokens: sentences first, then words. */
function splitOversized(text: string, max: number): string[] {
  if (estimateTokens(text) <= max) return [text];
  const out: string[] = [];
  let cur: string[] = [];
  const push = () => {
    if (cur.length) out.push(cur.join(" "));
    cur = [];
  };
  for (const s of sentences(text)) {
    if (estimateTokens(s) > max) {
      push();
      const words = s.split(/\s+/);
      let w: string[] = [];
      for (const word of words) {
        if (w.length && estimateTokens([...w, word].join(" ")) > max) {
          out.push(w.join(" "));
          w = [];
        }
        w.push(word.length > max * 4 ? word.slice(0, max * 4) : word);
      }
      if (w.length) out.push(w.join(" "));
      continue;
    }
    if (cur.length && estimateTokens([...cur, s].join(" ")) > max) push();
    cur.push(s);
  }
  push();
  return out;
}

/** The trailing sentences of `text` that fit in `budget` tokens. */
function tail(text: string, budget: number): string {
  if (budget <= 0) return "";
  const picked: string[] = [];
  for (const s of sentences(text).reverse()) {
    if (estimateTokens([s, ...picked].join(" ")) > budget) break;
    picked.unshift(s);
  }
  return picked.join(" ");
}

/** Packs blocks into chunks of at most `max` tokens. Small sections share a chunk; big ones get their own. */
function pack(blocks: Block[], opts: ChunkOptions): Chunk[] {
  const { max, overlapTokens } = optsOf(opts);
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let heading = "";
  let lastSection = -1;
  const tokens = () => estimateTokens(parts.join("\n\n"));
  const emit = () => {
    const content = parts.join("\n\n").trim();
    if (content) chunks.push({ heading, content });
    parts = [];
  };
  for (const block of blocks) {
    // Pieces of an oversized block leave room for the overlap carried into the next chunk.
    const pieces = estimateTokens(block.text) > max ? splitOversized(block.text, max - overlapTokens) : [block.text];
    for (const piece of pieces) {
      const newSection = block.sectionId !== lastSection;
      const wouldOverflow = parts.length > 0 && estimateTokens([...parts, piece].join("\n\n")) > max;
      // Start a fresh chunk at a section boundary once the current one is reasonably full.
      const sectionBreak = parts.length > 0 && newSection && block.startsSection && tokens() >= max * 0.5;
      if (wouldOverflow || sectionBreak) {
        const prev = parts.join("\n\n");
        emit();
        // Overlap only inside one section: carrying text across headings blurs both.
        if (!newSection) {
          const carry = tail(prev, Math.min(overlapTokens, max - estimateTokens(piece)));
          if (carry) parts.push(carry);
        }
      }
      if (!parts.length) heading = block.heading;
      parts.push(piece);
      lastSection = block.sectionId;
    }
  }
  emit();
  return chunks;
}

export function chunkMarkdown(text: string, opts: ChunkOptions = {}): Chunk[] {
  return pack(markdownBlocks(text), opts);
}

/** Plain text: paragraphs (blank-line separated), no headings. */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return pack(paragraphs.map((p) => ({ heading: "", text: p, sectionId: 0, startsSection: false })), opts);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function itemLabel(item: unknown, index: number): string {
  if (isPlainObject(item)) {
    for (const k of ["title", "name", "handle", "id", "question", "label", "kind"]) {
      const v = item[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
    }
  }
  return `item ${index + 1}`;
}

const yamlText = (v: unknown) => stringifyYaml(v, { lineWidth: 0 }).trim();

/**
 * YAML: one chunk per item of every list of objects (proof inventory items, competitors, sources, offers);
 * everything else (scalars, lists of words) is packed together as the file's overview.
 */
export function chunkYaml(text: string, opts: ChunkOptions = {}): Chunk[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return chunkText(text, opts);
  }
  if (doc === null || doc === undefined) return [];
  const { max } = optsOf(opts);
  const out: Chunk[] = [];
  const pushItem = (heading: string, value: unknown) => {
    for (const piece of splitOversized(yamlText(value), max)) out.push({ heading, content: piece });
  };
  if (Array.isArray(doc)) {
    doc.forEach((item, i) => pushItem(itemLabel(item, i), item));
    return out.filter((c) => c.content);
  }
  if (!isPlainObject(doc)) return chunkText(String(doc), opts);
  const overview: Block[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (Array.isArray(value) && value.some(isPlainObject)) {
      value.forEach((item, i) => pushItem(`${key} › ${itemLabel(item, i)}`, item));
    } else {
      overview.push({ heading: "", text: yamlText({ [key]: value }), sectionId: 0, startsSection: false });
    }
  }
  return [...pack(overview, opts), ...out].filter((c) => c.content);
}

export type ChunkFormat = "markdown" | "yaml" | "text";

export function formatForPath(path: string | null | undefined): ChunkFormat {
  if (!path) return "markdown";
  if (/\.ya?ml$/i.test(path)) return "yaml";
  if (/\.txt$/i.test(path)) return "text";
  return "markdown";
}

export function chunkDocument(text: string, format: ChunkFormat, opts: ChunkOptions = {}): Chunk[] {
  if (format === "yaml") return chunkYaml(text, opts);
  if (format === "text") return chunkText(text, opts);
  return chunkMarkdown(text, opts);
}

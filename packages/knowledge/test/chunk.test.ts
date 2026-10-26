import { describe, expect, it } from "vitest";
import { chunkDocument, chunkMarkdown, chunkText, chunkYaml, estimateTokens, formatForPath } from "../src/chunk.ts";

const para = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} sentence number ${i} explains one idea.`).join(" ");

describe("markdown chunking", () => {
  it("keeps the heading path and merges small sections into one chunk", () => {
    const md = "# Voice\n\nShort intro.\n\n## Signature moves\n\n- Opens with the cost\n- Counts on fingers\n\n## Never say\n\n- Hype words\n";
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("Voice");
    expect(chunks[0]!.content).toContain("## Never say");
    expect(chunks[0]!.content).toContain("- Counts on fingers");
  });

  it("splits long documents under the token ceiling, breaking at sections once a chunk is half full", () => {
    const md = `# Guide\n\n## Pricing\n\n${para("pricing", 40)}\n\n${para("pricing", 40)}\n\n## Permits\n\n${para("permits", 30)}\n`;
    const chunks = chunkMarkdown(md, { maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(estimateTokens(c.content)).toBeLessThanOrEqual(300);
    const permits = chunks.filter((c) => c.heading === "Guide › Permits");
    expect(permits.length).toBeGreaterThan(0);
    // a section break never carries text from the previous section
    expect(permits[0]!.content.startsWith("## Permits")).toBe(true);
    expect(permits.every((c) => !c.content.includes("pricing sentence"))).toBe(true);
  });

  it("overlaps consecutive chunks inside one section", () => {
    const md = `## Process\n\n${para("process", 60)}`;
    const chunks = chunkMarkdown(md, { maxTokens: 200, overlap: 0.2 });
    expect(chunks.length).toBeGreaterThan(2);
    const sentencesOf = (t: string) => t.split(/(?<=\.)\s+/);
    const firstOfSecond = sentencesOf(chunks[1]!.content)[0]!;
    expect(chunks[0]!.content).toContain(firstOfSecond);
    expect(chunks[1]!.content).toContain(sentencesOf(chunks[0]!.content).pop()!);
  });

  it("never splits headings inside code fences or the fence itself when it fits", () => {
    const md = "# Doc\n\n```\n# not a heading\ncode line\n```\n\n## Real\n\ntext";
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.heading)).toEqual(["Doc"]);
    expect(chunks[0]!.content).toContain("```\n# not a heading\ncode line\n```");
  });

  it("is deterministic and drops empty input", () => {
    const md = `# A\n\n${para("alpha", 50)}`;
    expect(chunkMarkdown(md, { maxTokens: 150 })).toEqual(chunkMarkdown(md, { maxTokens: 150 }));
    expect(chunkMarkdown("   \n\n")).toEqual([]);
  });

  it("hard-splits a single giant sentence by words", () => {
    const giant = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(giant, { maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(estimateTokens(c.content)).toBeLessThanOrEqual(200);
  });
});

describe("yaml chunking", () => {
  it("makes one chunk per list item and packs the rest as an overview", () => {
    const yaml = [
      "name: Examplebrand Studio",
      "oneLiner: Design-build consultancy",
      "hashtagPool: ['#renovation', '#designbuild']",
      "items:",
      "  - id: kitchen-1",
      "    kind: case_study",
      "    title: Galley kitchen opened up",
      "    summary: Removed a wall",
      "  - id: faq-permits",
      "    kind: faq",
      "    title: Do I need a permit?",
      "    summary: Usually yes",
    ].join("\n");
    const chunks = chunkYaml(yaml);
    expect(chunks.map((c) => c.heading)).toEqual(["", "items › Galley kitchen opened up", "items › Do I need a permit?"]);
    expect(chunks[0]!.content).toContain("hashtagPool");
    expect(chunks[1]!.content).toContain("kind: case_study");
    expect(chunks[1]!.content).not.toContain("faq-permits");
  });

  it("handles a top-level list and falls back to text for invalid YAML", () => {
    expect(chunkYaml("- name: one\n- name: two\n").map((c) => c.heading)).toEqual(["one", "two"]);
    expect(chunkYaml("key: [unclosed\n\nmore text").length).toBeGreaterThan(0);
  });

  it("picks the chunker from the file extension", () => {
    expect(formatForPath("brand/proof-inventory.yaml")).toBe("yaml");
    expect(formatForPath("brand/knowledge/notes.txt")).toBe("text");
    expect(formatForPath("brand/voice.md")).toBe("markdown");
    expect(chunkDocument("- name: a\n", "yaml")[0]!.heading).toBe("a");
  });
});

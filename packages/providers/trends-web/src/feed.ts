import { XMLParser } from "fast-xml-parser";

/** RSS 2.0 / Atom 1.0 parsing into plain entries. Tolerant: feeds in the wild are rarely valid. */

export type FeedEntry = {
  id: string;
  title: string;
  link: string;
  publishedAt?: string;
  author?: string;
  /** HTML stripped, whitespace collapsed. UNTRUSTED. */
  text?: string;
  /** Google News: the publisher in `<source>`. */
  source?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => ["item", "entry", "link", "category"].includes(name),
});

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function stripHtml(html: string | undefined | null, max = 1000): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#") && e !== "#39") return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Text of a node that may be a string, `{#text}` or missing. */
function textOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number") return String(v).trim() || undefined;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return textOf((v as Record<string, unknown>)["#text"]);
  return undefined;
}

function isoDate(v: unknown): string | undefined {
  const s = textOf(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function atomLink(links: unknown): string | undefined {
  if (!Array.isArray(links)) return textOf(links);
  const nodes = links as Record<string, unknown>[];
  const alt = nodes.find((l) => typeof l === "object" && (l["@rel"] === undefined || l["@rel"] === "alternate"));
  const pick = alt ?? nodes[0];
  if (!pick) return undefined;
  return typeof pick === "object" ? (pick["@href"] as string | undefined) ?? textOf(pick) : textOf(pick);
}

export function parseFeed(xml: string): FeedEntry[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: FeedEntry[] = [];
  const rss = (doc["rss"] as Record<string, unknown> | undefined)?.["channel"] as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  const items = (rss?.["item"] ?? rdf?.["item"]) as Record<string, unknown>[] | undefined;
  if (items) {
    for (const it of items) {
      const link = atomLink(it["link"]) ?? textOf(it["guid"]);
      const title = stripHtml(textOf(it["title"]), 300);
      if (!link || !title) continue;
      const source = it["source"];
      out.push({
        id: textOf(it["guid"]) ?? link,
        title,
        link,
        publishedAt: isoDate(it["pubDate"] ?? it["dc:date"]),
        author: textOf(it["dc:creator"]) ?? textOf(it["author"]),
        text: stripHtml(textOf(it["content:encoded"]) ?? textOf(it["description"])),
        source: textOf(source),
      });
    }
    return out;
  }
  const feed = doc["feed"] as Record<string, unknown> | undefined;
  for (const e of (feed?.["entry"] as Record<string, unknown>[] | undefined) ?? []) {
    const link = atomLink(e["link"]);
    const title = stripHtml(textOf(e["title"]), 300);
    if (!link || !title) continue;
    const author = e["author"] as Record<string, unknown> | undefined;
    out.push({
      id: textOf(e["id"]) ?? link,
      title,
      link,
      publishedAt: isoDate(e["published"] ?? e["updated"]),
      author: textOf(author?.["name"]),
      text: stripHtml(textOf(e["summary"]) ?? textOf(e["content"])),
    });
  }
  return out;
}

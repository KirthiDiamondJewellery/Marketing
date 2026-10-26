/**
 * A small, polite site reader for the business step: the home page plus a few same-site pages that usually describe
 * the offer (about, services, pricing). The text is UNTRUSTED: it only goes to a tool-less model call whose answer
 * is validated, never to an agent with tools.
 */

import { isIP } from "node:net";
import { fetchPublicPage, isPublicAddress } from "./public-http.ts";

export type PageText = { url: string; title: string; description: string; text: string };
export type SiteText = { pages: PageText[]; problems: string[] };

const UA = "AttentionOS-onboarding/0.1 (+https://github.com/evanbaker315/AttentionOS)";
const PAGE_CHARS = 6000;
const TOTAL_CHARS = 16_000;
const OFFER_HINT = /about|service|offer|pricing|price|work-with|programs?|coaching|consult|packages?|solutions?|what-we-do|how-it-works|team|story/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML page: no scripts, styles or markup; headings and list items on their own lines. */
export function htmlToText(html: string): { title: string; description: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const description = decodeEntities(
    (/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
      "").trim(),
  );
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/section|\/article|\/tr|\/header|\/footer)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((l) => l && l !== "-" && !/^#+$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { title, description, text };
}

/** Same-site links whose path suggests the offer or the story behind the business, best first. */
export function offerLinks(html: string, base: URL, max = 3): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1]!), base);
    } catch {
      continue;
    }
    if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
    if (!OFFER_HINT.test(u.pathname) || /\.(pdf|jpe?g|png|gif|webp|zip|mp4)$/i.test(u.pathname)) continue;
    u.hash = "";
    u.search = "";
    const s = u.toString();
    if (s !== base.toString() && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Refuses local and private addresses: the worker shouldn't be pointed at the owner's own network. */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(h)) return isPublicAddress(h);
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || (!h.includes(".") && !h.includes(":"))) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:")) return false;
  return true;
}

export function normalizeSiteUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  return isPublicHttpUrl(withScheme) ? new URL(withScheme).toString() : null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getPage(url: string, fetchImpl: Fetch, timeoutMs: number): Promise<{ html: string; finalUrl: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  for (let redirects = 0; ; redirects++) {
    if (!isPublicHttpUrl(url)) throw new Error("Not a public HTTP address.");
    res = await fetchImpl(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (!location || redirects >= 4) throw new Error("Too many redirects or missing redirect address.");
    url = new URL(location, url).toString();
  }
  if (!res.ok) throw new Error(`the page answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html|xml|text\/plain/i.test(type)) throw new Error("it isn't a web page");
  const html = (await res.text()).slice(0, 1_500_000);
  return { html, finalUrl: res.url || url };
}

/** Reads the site: the given pages first, then up to three offer-looking links from the home page. */
export async function readSite(urls: string[], opts: { fetch?: Fetch; timeoutMs?: number; maxPages?: number } = {}): Promise<SiteText> {
  const fetchImpl = opts.fetch ?? fetchPublicPage;
  const maxPages = opts.maxPages ?? 5;
  const pages: PageText[] = [];
  const problems: string[] = [];
  const queue = urls.map((u) => normalizeSiteUrl(u)).filter((u): u is string => Boolean(u));
  if (!queue.length) return { pages, problems: ["No public web address to read."] };
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < queue.length && pages.length < maxPages && total < TOTAL_CHARS; i++) {
    const url = queue[i]!;
    if (seen.has(url) || !isPublicHttpUrl(url)) continue;
    seen.add(url);
    try {
      const { html, finalUrl } = await getPage(url, fetchImpl, opts.timeoutMs ?? 12_000);
      const page = htmlToText(html);
      const text = page.text.slice(0, Math.min(PAGE_CHARS, TOTAL_CHARS - total));
      total += text.length;
      pages.push({ url: finalUrl, title: page.title.slice(0, 200), description: page.description.slice(0, 400), text });
      if (i === 0) for (const link of offerLinks(html, new URL(finalUrl))) if (!queue.includes(link)) queue.push(link);
    } catch (err) {
      problems.push(`Couldn't read ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { pages, problems };
}

/** Removes anything that looks like our own prompt delimiters from untrusted text. */
export function fence(text: string, max: number): string {
  return text.replace(/<\/?\s*untrusted[^>]*>/gi, "").slice(0, max);
}

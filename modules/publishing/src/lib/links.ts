import { z } from "zod";
import type { Platform } from "@attentionos/core";

/**
 * Tracked links. Every post gets `utm_content=<prefix><keyword>_<post#>` so a lead or sale can be
 * traced back to the post that produced it. An optional short link is created on the user's own site through
 * the companion website's link API.
 */

export type Utm = { utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string };

/** `<prefix><keyword>_<post#>`, lowercased, only [a-z0-9_-]. Without a keyword: `<prefix>post_<post#>`. */
export function buildUtmContent(opts: { prefix?: string; keyword?: string | null; postNumber: number }): string {
  if (!Number.isInteger(opts.postNumber) || opts.postNumber < 1) throw new Error("post number must be a positive whole number");
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  const keyword = opts.keyword ? clean(opts.keyword) : "";
  return `${clean(opts.prefix ?? "")}${keyword || "post"}_${opts.postNumber}`;
}

/** Reads the post number back out of a utm_content tag (`..._<n>`). */
export function postNumberFromUtm(utmContent: string): number | undefined {
  const m = /_(\d+)$/.exec(utmContent);
  return m ? Number(m[1]) : undefined;
}

export function buildUtm(opts: { platform: Platform | string; medium: string; campaign: string; content: string }): Utm {
  return { utm_source: opts.platform, utm_medium: opts.medium, utm_campaign: opts.campaign, utm_content: opts.content };
}

/** Adds UTM parameters to a destination URL, replacing any existing ones. */
export function buildTrackedUrl(destination: string, utm: Utm): string {
  const url = new URL(destination);
  for (const [k, v] of Object.entries(utm)) url.searchParams.set(k, v);
  return url.toString();
}

export const shortLinkResponseSchema = z.object({
  slug: z.string().min(1),
  shortUrl: z.string().url(),
  fullUrl: z.string().url(),
});
export type ShortLink = z.output<typeof shortLinkResponseSchema>;

export type ShortLinkRequest = {
  siteUrl: string;
  /** Path of the link API on the site. */
  apiPath: string;
  token: string;
  destination: string;
  utm: Utm;
  label: string;
  creator?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export class ShortLinkError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ShortLinkError";
  }
}

/**
 * `POST {siteUrl}{apiPath}` with a bearer token.
 * Body: `{ destination, creator?, utm: {utm_source, utm_medium, utm_campaign, utm_content}, label }`
 * Response: `{ slug, shortUrl, fullUrl }`.
 */
export async function createShortLink(req: ShortLinkRequest): Promise<ShortLink> {
  const doFetch = req.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const endpoint = new URL(req.apiPath, req.siteUrl).toString();
  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${req.token}` },
      body: JSON.stringify({ destination: req.destination, ...(req.creator ? { creator: req.creator } : {}), utm: req.utm, label: req.label }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ShortLinkError(`Couldn't reach your site's link service: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " Check the link token in your .env." : "";
    throw new ShortLinkError(`Your site's link service said no (HTTP ${res.status}).${hint}`, res.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ShortLinkError("Your site's link service sent back something that isn't JSON.", res.status);
  }
  const parsed = shortLinkResponseSchema.safeParse(json);
  if (!parsed.success) throw new ShortLinkError("Your site's link service sent back an unexpected answer (expected slug, shortUrl, fullUrl).", res.status);
  return parsed.data;
}

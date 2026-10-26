import type { Platform, WorkspaceContext } from "@attentionos/core";
import { publishingSettings, PUBLISHING_SECRETS } from "../settings.ts";
import { buildTrackedUrl, buildUtm, buildUtmContent, createShortLink, ShortLinkError, type Utm } from "./links.ts";

export type Tracking = { utmContent: string; utm?: Utm; trackedUrl?: string; shortLink?: string; note?: string };

/** Where links for this piece point: its lead magnet, else the configured default, else the brand site. */
export function linkDestination(ws: WorkspaceContext, leadMagnetUrl: string | null): string | undefined {
  if (leadMagnetUrl) return leadMagnetUrl;
  const s = publishingSettings(ws.config);
  if (s.tracking.defaultDestination) return s.tracking.defaultDestination;
  try {
    return ws.brand().brand.cta.siteUrl;
  } catch {
    return undefined;
  }
}

function utmPrefix(ws: WorkspaceContext): string {
  try {
    return ws.brand().brand.cta.utmContentPrefix;
  } catch {
    return "";
  }
}

/**
 * Tracking for one post: `utm_content=<prefix><keyword>_<post#>` (the same tag on every platform of a piece, so
 * leads roll up per post) plus a tracked URL with `utm_source=<platform>`. With `createShort`, also a short link on
 * the user's own site. Short-link failures never block publishing; they come back as a note.
 */
export async function trackingFor(ws: WorkspaceContext, args: {
  platform: Platform | string;
  keyword: string | null;
  postNumber: number;
  leadMagnetUrl: string | null;
  label: string;
  createShort: boolean;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<Tracking> {
  const s = publishingSettings(ws.config);
  const utmContent = buildUtmContent({ prefix: utmPrefix(ws), keyword: args.keyword, postNumber: args.postNumber });
  const destination = linkDestination(ws, args.leadMagnetUrl);
  if (!destination) return { utmContent, note: "No link destination yet (set brand.cta.siteUrl or register a lead magnet)." };
  const utm = buildUtm({ platform: args.platform, medium: s.tracking.utmMedium, campaign: s.tracking.utmCampaign, content: utmContent });
  const trackedUrl = buildTrackedUrl(destination, utm);
  if (!args.createShort || !s.tracking.shortLinks) return { utmContent, utm, trackedUrl };
  let siteUrl: string | undefined;
  try {
    siteUrl = ws.brand().brand.cta.siteUrl;
  } catch {
    siteUrl = undefined;
  }
  const token = ws.secret(PUBLISHING_SECRETS.linksApiToken);
  if (!siteUrl || !token) return { utmContent, utm, trackedUrl, note: `Short links are on but ${!siteUrl ? "brand.cta.siteUrl" : PUBLISHING_SECRETS.linksApiToken} is missing.` };
  try {
    const short = await createShortLink({ siteUrl, apiPath: s.tracking.linkApiPath, token, destination, utm, label: args.label, ...(args.fetch ? { fetch: args.fetch } : {}) });
    return { utmContent, utm, trackedUrl: short.fullUrl, shortLink: short.shortUrl };
  } catch (err) {
    const msg = err instanceof ShortLinkError ? err.message : (err as Error).message;
    ws.log.warn("publishing: short link failed, using the full tracked link", { error: msg });
    return { utmContent, utm, trackedUrl, note: msg };
  }
}

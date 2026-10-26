import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";

export function publicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (isIP(host) && !isPublicAddress(host))) throw new Error("Not a public HTTP address.");
  return url;
}

function openPublic(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { lookup: publicLookup, signal }, resolve);
    req.on("error", reject);
    req.end();
  });
}

/** Enforces the actual streamed byte count even when Content-Length is absent or dishonest. */
export function byteLimit(maxBytes: number): Transform {
  let received = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    callback(received > maxBytes ? new Error("The media file exceeds the download limit.") : null, chunk);
  } });
}

/** DNS-pinned, redirect-checked, bounded streaming download. Failed downloads never replace the destination. */
export async function downloadPublicFile(raw: string, destination: string, options: { signal: AbortSignal; maxBytes: number; timeoutMs?: number }): Promise<string> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 180_000)]);
  let url = publicHttpUrl(raw);
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await openPublic(url, signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects >= 4) throw new Error("Too many media redirects or missing Location.");
        url = publicHttpUrl(new URL(location, url).href);
        continue;
      }
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300 || Number(response.headers["content-length"] ?? 0) > options.maxBytes) {
        response.destroy();
        throw new Error("Media download refused or too large.");
      }
      await pipeline(response, byteLimit(options.maxBytes), createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
      await rename(temporary, destination);
      return destination;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // Reject mapped IPv4, local, multicast and transition addresses as well as reserved ranges.
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

/** Validate DNS inside the socket's lookup, so a second lookup cannot rebind to an internal address. */
type LookupCallback = (error: NodeJS.ErrnoException | null, addresses?: string | { address: string; family: number }[], family?: number) => void;
export const publicLookup: typeof lookup = ((hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return callback(new Error("The site resolves to a non-public address."));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as typeof lookup;

/** Bounded GET with no automatic redirects, decompression or proxy environment inheritance. */
export async function fetchPublicPage(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || (isIP(hostname) && !isPublicAddress(hostname))) throw new Error("Not a public HTTP address.");
  return new Promise((resolve, reject) => {
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      lookup: publicLookup,
      signal: init.signal ?? undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_500_000) res.destroy(new Error("The page is too large."));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const status = res.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

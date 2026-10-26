/**
 * Thread refs ("rf-123 v2", "ap-7") let a reply find the work it belongs to. Every message we send with a
 * `ref` ends with a footer line `ref rf-123 v2`; when the user replies to that message (or to a video whose
 * caption carries the footer), we read the ref back from the quoted text. Telegram includes the replied-to
 * message's text and caption in the update, so no lookup table is needed.
 */

export const REF_TOKEN = /\b([a-z]{1,4}-\d{1,9})(?:\s+v(\d{1,4}))?\b/i;

/** Prefixes we recognise outside the footer: edit revisions (rf) and approvals (ap). */
const KNOWN_REF = /\b((?:rf|ap)-\d{1,9})(?:\s+v(\d{1,4}))?\b/gi;

export function refFooter(ref: string): string {
  return `ref ${ref}`;
}

/** Finds the ref in a message we sent: the footer first, then the last ref-looking token. */
export function extractRef(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const footer = /(?:^|\n)ref ([a-z]{1,4}-\d{1,9}(?: v\d{1,4})?)\s*$/i.exec(text.trimEnd());
  if (footer?.[1]) return normalizeRef(footer[1]);
  const all = [...text.matchAll(KNOWN_REF)];
  const lastMatch = all[all.length - 1];
  return lastMatch ? normalizeRef(lastMatch[0]) : undefined;
}

export function normalizeRef(raw: string): string {
  const m = REF_TOKEN.exec(raw.trim());
  if (!m?.[1]) return raw.trim();
  return m[2] ? `${m[1].toLowerCase()} v${Number(m[2])}` : m[1].toLowerCase();
}

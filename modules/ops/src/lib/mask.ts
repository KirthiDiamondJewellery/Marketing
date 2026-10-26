/**
 * Reel mode / demo mode: when it's on, names, handles, emails and phone numbers of OTHER people
 * (leads, commenters, tracked creators) are replaced with consistent fictional ones, so the owner can film the
 * product without exposing anyone. Numbers (views, x-scores, revenue) are never changed.
 *
 * Masking is deterministic per real value, so the same person keeps the same stand-in across messages.
 */

const FIRST = ["Avery", "Blair", "Casey", "Dana", "Ellis", "Finley", "Gray", "Harper", "Indy", "Jules", "Kai", "Lane", "Marlo", "Noor", "Oakley", "Peyton", "Quinn", "Remy", "Sage", "Tatum"];
const LAST = ["Ashdown", "Birch", "Coldwell", "Dunmore", "Eastvale", "Fenwick", "Glenhart", "Holt", "Ivers", "Juniper", "Kestrel", "Larkin", "Moorland", "Northcott", "Oakhurst", "Pembrook", "Quarry", "Redfern", "Stillwater", "Thornbury"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function fakeName(seed: string): string {
  const h = hash(seed.toLowerCase());
  return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`;
}

export function fakeHandle(seed: string): string {
  const h = hash(seed.toLowerCase().replace(/^@/, ""));
  return `@member_${(h % 0xffff).toString(16).padStart(4, "0")}`;
}

export function fakeEmail(seed: string): string {
  const [first, last] = fakeName(seed).toLowerCase().split(" ");
  return `${first}.${last}@example.com`;
}

export type MaskSource = { names?: string[]; handles?: string[]; emails?: string[]; phones?: string[] };

/** Builds [real, fake] pairs, longest first so "Avery Stone Builders" wins over "Avery Stone". */
export function maskPairs(src: MaskSource): Array<[string, string]> {
  const out = new Map<string, string>();
  const add = (real: string | undefined | null, fake: string) => {
    const r = real?.trim();
    if (r && r.length > 2 && r !== fake && !out.has(r)) out.set(r, fake);
  };
  for (const n of src.names ?? []) {
    const fake = fakeName(n);
    add(n, fake);
    const [rf, ...rl] = n.trim().split(/\s+/);
    const [ff, ...fl] = fake.split(" ");
    if (rl.length) {
      add(rf, ff!);
      add(rl.join(" "), fl.join(" "));
    }
  }
  for (const h of src.handles ?? []) {
    const bare = h.replace(/^@/, "");
    const fake = fakeHandle(bare);
    add(`@${bare}`, fake);
    add(bare, fake.slice(1));
  }
  for (const e of src.emails ?? []) add(e, fakeEmail(e));
  for (const p of src.phones ?? []) add(p, "(hidden)");
  return [...out].sort((a, b) => b[0].length - a[0].length);
}

/** Replaces whole-word occurrences (case-insensitive for handles and emails). */
export function maskText(text: string, pairs: Array<[string, string]>): string {
  let out = text;
  for (const [real, fake] of pairs) {
    const escaped = real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_@.])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), fake);
  }
  return out;
}

export type Masker = { on: boolean; text(s: string): string };

export const NO_MASK: Masker = { on: false, text: (s) => s };

export function createMasker(on: boolean, pairs: Array<[string, string]>): Masker {
  if (!on || !pairs.length) return { on, text: (s) => s };
  return { on, text: (s) => maskText(s, pairs) };
}

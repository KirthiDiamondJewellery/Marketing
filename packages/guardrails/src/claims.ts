import { z } from "zod";
import { IssueCollector, type ValidationResult } from "./issues.ts";
import { extractNumbers, parseNumber } from "./numbers.ts";
import { normalizeQuotes, truncate } from "./text.ts";

/**
 * Claim ledger ("Never invent a number", §5.3). Every factual claim in a script is listed
 * with a verdict and a source:
 * - PASS: verified against a source; may be said.
 * - FIX: was wrong and has been corrected (the note says how); the corrected wording needs its own PASS entry.
 * - CUT: could not be verified; must not appear in the script.
 * Numbers may only come from the proof inventory (`brand/proof-inventory.yaml`) or cited sources.
 */

export const CLAIM_VERDICTS = ["PASS", "FIX", "CUT"] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

export const claimEntrySchema = z.object({
  /** Optional stable id so edit-plan overlays can point at this claim as their evidenceId. */
  id: z.string().min(1).optional(),
  claim: z.string().min(1),
  verdict: z.enum(CLAIM_VERDICTS),
  /**
   * Where it was verified: `proof:<id>` (proof inventory item), `cited:<id>` (a cited source such as a trend
   * or research note), a bare id of either, or an https URL.
   */
  source: z.string().nullable().optional(),
  note: z.string().optional(),
});
export type ClaimEntry = z.output<typeof claimEntrySchema>;

export type ProofSource = {
  id: string;
  title?: string;
  /** Mirrors proof-inventory.yaml `numbers`. */
  numbers: { value: string; label?: string; source?: string }[];
  clientConsent?: boolean;
};

export type CitedSource = {
  id: string;
  url?: string;
  title?: string;
  /** Numbers the source states. When present, cited numbers must be among them. */
  numbers?: (string | number)[];
  /** True when two or more independent sources agree. Single-source claims need hedge framing. */
  corroborated?: boolean;
};

export type SpentStat = { value: string | number; usedAt?: string; scriptRef?: string };

/**
 * The owner's own pages and offers (brand.yaml offers, website). A claim about the owner's own offer ("the audit is
 * free") is theirs to make, so it needs no "they say" framing. Cite as `offer:<id>` or a link on their own site.
 */
export type OwnSource = {
  id: string;
  url?: string;
  title?: string;
  /** Any link on this url's site counts (the owner's website). Otherwise only this exact link (one of their own posts). */
  wholeSite?: boolean;
};

export type ClaimSources = {
  proof: ProofSource[];
  cited: CitedSource[];
  own?: OwnSource[];
  /** Numbers said in the last N scripts. Reusing one warns ("spent stat"). */
  recentStats?: SpentStat[];
};

/** Generic statistics that are folklore, not findings. Matched against claims and scripts. */
export const KNOWN_FAKE_STATS: readonly { id: string; pattern: RegExp; label: string }[] = [
  { id: "ten-percent-brain", pattern: /\b(only )?(use|using|uses)\b[^.]{0,30}\b(10|ten)\s?(%|percent)\s+of\s+(our|your|their|the|his|her)\s+brains?\b/i, label: "people only use 10% of their brain" },
  { id: "goldfish-attention", pattern: /\bgoldfish\b[^.]{0,60}\battention\b|\battention spans?\b[^.]{0,60}\bgoldfish\b/i, label: "humans have a shorter attention span than a goldfish" },
  { id: "eight-second-attention", pattern: /\b(8|eight)[- ]second attention span|\battention spans?\b[^.]{0,40}\b(8|eight) seconds\b/i, label: "the average attention span is 8 seconds" },
  { id: "mehrabian-93", pattern: /\b(93|ninety[- ]three)(\s?%|\s?percent\b)[^.]{0,60}\b(communication|non-?verbal|body language)\b|\b(7|seven)(\s?%|\s?percent\b)[^.]{0,40}\bwords\b[^.]{0,60}\b(tone|body language)\b/i, label: "93% of communication is nonverbal" },
  { id: "habit-21-days", pattern: /\b(21|twenty[- ]one) days\b[^.]{0,40}\b(habit|habits)\b|\b(habit|habits)\b[^.]{0,40}\b(21|twenty[- ]one) days\b/i, label: "it takes 21 days to form a habit" },
  { id: "rule-of-seven", pattern: /\b(7|seven) times\b[^.]{0,60}\b(before (they|people|someone|a customer|customers) buy)\b/i, label: "people need to see a message 7 times before they buy" },
  { id: "spiders-swallowed", pattern: /\bswallow\w*\b[^.]{0,40}\bspiders?\b/i, label: "people swallow spiders in their sleep" },
  { id: "glasses-of-water", pattern: /\b(8|eight) glasses of water\b/i, label: "everyone needs 8 glasses of water a day" },
  { id: "small-business-failure", pattern: /\b(9|nine) out of (10|ten) (startups|businesses|small businesses) fail\b|\b(80|eighty|90|ninety)(\s?%|\s?percent) of (new )?(small )?businesses fail\b/i, label: "most small businesses fail in their first year (usually misquoted)" },
  { id: "written-goals-study", pattern: /\b(3|three)(\s?%|\s?percent\b)[^.]{0,60}\bwritten goals\b|\bwritten goals\b[^.]{0,60}\b(97|ninety[- ]seven)(\s?%|\s?percent\b)/i, label: "the written-goals study (it never happened)" },
];

/** Returns every known fake stat the text repeats. */
export function findFakeStats(text: string): { id: string; label: string; match: string }[] {
  const t = normalizeQuotes(text);
  const out: { id: string; label: string; match: string }[] = [];
  for (const f of KNOWN_FAKE_STATS) {
    const m = f.pattern.exec(t);
    if (m) out.push({ id: f.id, label: f.label, match: m[0] });
  }
  return out;
}

const HEDGE_RE = /\b(they say|they said|says|said|according to|reports?|reported|reportedly|claims?|claimed|found that|finds that|estimates?|estimated|per (the|a|an|their|its)|suggests?|in (a|one|their) (study|survey|report))\b/i;

export function isHedged(text: string): boolean {
  return HEDGE_RE.test(normalizeQuotes(text));
}

type ResolvedSource =
  | { kind: "proof"; ref: string; item: ProofSource }
  | { kind: "cited"; ref: string; item: CitedSource }
  | { kind: "own"; ref: string; item: OwnSource }
  | { kind: "url"; ref: string };

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

export function resolveClaimSource(source: string, sources: ClaimSources): ResolvedSource | null {
  const s = source.trim();
  const [prefix, rest] = s.includes(":") && !/^https?:\/\//i.test(s) ? [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)] : ["", s];
  if (prefix === "proof" || prefix === "") {
    const item = sources.proof.find((p) => p.id === rest);
    if (item) return { kind: "proof", ref: s, item };
  }
  if (prefix === "cited" || prefix === "trend" || prefix === "source" || prefix === "") {
    const item = sources.cited.find((c) => c.id === rest || (c.url !== undefined && c.url === s));
    if (item) return { kind: "cited", ref: s, item };
  }
  // The owner's own offers: "offer:<id>" (a model sometimes writes cited:<offer id>, which means the same).
  if (prefix === "offer" || prefix === "own" || prefix === "cited" || prefix === "") {
    const item = sources.own?.find((o) => o.id === rest);
    if (item) return { kind: "own", ref: s, item };
  }
  if (/^https:\/\/\S+$/i.test(s)) {
    const item = sources.cited.find((c) => c.url === s);
    if (item) return { kind: "cited", ref: s, item };
    const host = hostOf(s);
    const sameLink = (a: string, b: string | undefined) => !!b && a.replace(/[/?#]+$/, "").toLowerCase() === b.replace(/[/?#]+$/, "").toLowerCase();
    const own = sources.own?.find((o) => sameLink(s, o.url)) ?? (host ? sources.own?.find((o) => o.wholeSite && hostOf(o.url) === host) : undefined);
    if (own) return { kind: "own", ref: s, item: own };
    return { kind: "url", ref: s };
  }
  return null;
}

function valuesOf(list: readonly (string | number)[]): Set<number> {
  const out = new Set<number>();
  for (const v of list) {
    const n = parseNumber(v);
    if (n !== null) out.add(n);
  }
  return out;
}

export function validateClaimLedger(claims: readonly unknown[], sources: ClaimSources): ValidationResult {
  const c = new IssueCollector();
  const spent = new Map<number, SpentStat>();
  for (const s of sources.recentStats ?? []) {
    const n = parseNumber(s.value);
    if (n !== null && !spent.has(n)) spent.set(n, s);
  }
  const ids = new Set<string>();

  claims.forEach((raw, i) => {
    const path = `claimLedger[${i}]`;
    const parsed = claimEntrySchema.safeParse(raw);
    if (!parsed.success) {
      c.error("claims.shape", `Claim ${i + 1} isn't a valid ledger entry: ${parsed.error.issues.map((x) => `${x.path.join(".") || "entry"} ${x.message}`).join("; ")}.`, {
        path,
        fix: 'Each entry needs {"claim": "...", "verdict": "PASS" | "FIX" | "CUT", "source": "proof:<id>" | "cited:<id>" | "https://..."}.',
      });
      return;
    }
    const entry = parsed.data;
    const quote = `"${truncate(entry.claim, 70)}"`;
    if (entry.id) {
      if (ids.has(entry.id)) c.error("claims.duplicate_id", `Two claims share the id "${entry.id}".`, { path: `${path}.id`, fix: "Give every claim its own id." });
      ids.add(entry.id);
    }

    for (const fake of findFakeStats(entry.claim)) {
      c.error("claims.fake_stat", `Claim ${quote} repeats a known fake statistic (${fake.label}).`, { path, fix: "Cut it. No source makes this one true." });
    }

    if (entry.verdict === "CUT") return;

    if (entry.verdict === "FIX" && !entry.note) {
      c.warn("claims.fix_without_note", `Claim ${quote} is marked FIX but doesn't say what was corrected.`, {
        path: `${path}.note`,
        fix: "Add a note with the original wording and the correction, and list the corrected claim as its own PASS entry.",
      });
    }

    if (!entry.source || !entry.source.trim()) {
      c.error("claims.no_source", `Claim ${quote} is marked ${entry.verdict} but has no source.`, {
        path: `${path}.source`,
        fix: "Add the proof inventory item (proof:<id>) or cited source (cited:<id> or an https link) it was checked against, or mark it CUT.",
      });
      return;
    }
    const resolved = resolveClaimSource(entry.source, sources);
    if (!resolved) {
      c.error("claims.unknown_source", `Claim ${quote} cites "${entry.source}", which isn't in the proof inventory or the cited sources.`, {
        path: `${path}.source`,
        fix: "Cite an item from brand/proof-inventory.yaml (proof:<id>), one of the owner's offers (offer:<id>), a cited source id (cited:<id>), or an https link to where it was verified.",
      });
      return;
    }

    const numbers = extractNumbers(entry.claim, { all: true });
    if (resolved.kind === "proof") {
      const allowed = valuesOf(resolved.item.numbers.map((n) => n.value));
      for (const num of numbers) {
        if (!allowed.has(num.value)) {
          c.error("claims.number_not_in_proof", `Claim ${quote} says "${num.raw}", but proof item "${resolved.item.id}" doesn't record that number.`, {
            path,
            fix: `Use the number exactly as recorded in brand/proof-inventory.yaml (${resolved.item.numbers.map((n) => n.value).join(", ") || "it records no numbers"}), or add the real number to the inventory first.`,
          });
        }
      }
    } else {
      if (resolved.kind === "cited" && resolved.item.numbers && resolved.item.numbers.length > 0) {
        const allowed = valuesOf(resolved.item.numbers);
        for (const num of numbers) {
          if (!allowed.has(num.value)) {
            c.error("claims.number_not_in_source", `Claim ${quote} says "${num.raw}", but the cited source "${resolved.item.id}" doesn't state that number.`, {
              path,
              fix: "Use the number exactly as the source states it, or cut the number.",
            });
          }
        }
      } else if (numbers.length > 0) {
        c.warn("claims.number_unverifiable", `Claim ${quote} has a number from "${entry.source}" that can't be checked automatically.`, {
          path,
          fix: "Record the number on the source (its numbers list) so the check can confirm it.",
        });
      }
      // The owner's own offer and site are theirs to state; outside sources are framed as theirs.
      const corroborated = resolved.kind === "own" || (resolved.kind === "cited" && resolved.item.corroborated === true);
      if (!corroborated && !isHedged(entry.claim)) {
        c.error("claims.needs_hedge", `Claim ${quote} rests on a single outside source, so it must be framed as theirs.`, {
          path,
          fix: 'Say who says it: "they say", "according to <source>", "<source> found that". Or add a second independent source.',
        });
      }
    }

    for (const num of numbers) {
      const used = spent.get(num.value);
      if (used) {
        c.warn("claims.spent_stat", `"${num.raw}" was already used in a recent script${used.usedAt ? ` (${used.usedAt.slice(0, 10)})` : ""}${used.scriptRef ? `, ${used.scriptRef}` : ""}. Repeated stats read as filler to returning viewers.`, {
          path,
          fix: "Lead with a different proof point from the inventory, or give this one a new angle.",
        });
      }
    }
  });
  return c.result();
}

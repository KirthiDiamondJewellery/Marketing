import { normalizeQuotes } from "./text.ts";

/**
 * Banned openers and phrases. Brand-specific lists come from the Brand Kit
 * (`brand/brand.yaml` `bannedPhrases` and the banned sections of `brand/voice.md`); the engine
 * only ships generic method lists below.
 */

/** Openers that delay the topic or close the loop before it opens. Generic method, any niche. */
export const DEFAULT_BANNED_OPENERS: readonly string[] = [
  "let me explain",
  "let's talk about",
  "let's dive in",
  "in this video",
  "in today's video",
  "hey guys",
  "hi guys",
  "hey everyone",
  "hi everyone",
  "what's up guys",
  "welcome back",
  "so today",
  "today i'm going to",
  "today i'll show you",
  "today we're going to",
  "before i get into it",
  "before we start",
  "you won't believe",
  "wait till you see",
  "wait until you see",
  "here are",
  "here's how to",
  "i want to talk about",
  "quick tip",
  "did you know",
];

/** CTA verbs that may close a script but never open one. */
export const CTA_OPENERS: readonly string[] = ["comment", "follow me", "follow for", "link in bio", "link in my bio", "dm me", "book a call", "save this", "share this"];

/**
 * Sales words and empty intensifiers that read as written-by-a-model when spoken. Reported as
 * warnings: the Brand Kit decides which ones are hard bans.
 */
export const DEFAULT_SALES_WORDS: readonly string[] = [
  "game-changer", "game changer", "game-changing", "revolutionary", "revolutionize", "cutting-edge", "cutting edge",
  "seamless", "seamlessly", "robust", "unlock", "unleash", "leverage", "streamline", "supercharge", "elevate",
  "transformative", "empower", "effortless", "effortlessly", "next-level", "next level", "skyrocket", "delve",
  "in today's fast-paced world", "at the end of the day", "it's important to note", "let that sink in",
];

/** Staged run-ups that delay the point. Warnings. */
export const DEFAULT_RUN_UPS: readonly string[] = [
  "here's the thing", "let's be honest", "real talk", "honestly?", "the truth is", "make no mistake", "don't get me wrong", "i'm not saying",
];

export type BannedLists = { openers: string[]; phrases: string[] };

const OPENER_HEADING = /\b(banned|never|don'?t|do not|avoid)\b.*\b(open|opener|openers|opening|start|starts|first (line|words))\b|\bopeners?\b.*\b(banned|never|avoid)\b/i;
const PHRASE_HEADING = /\b(banned|never say|never use|words? (we|i) never|do not say|don'?t say|avoid|off[- ]limits|never)\b/i;

/**
 * Reads the banned lists out of `brand/voice.md`.
 *
 * Convention (documented in the voice-profile skill): any heading containing "banned", "never" or
 * "avoid" starts a banned section; a heading that also mentions openers ("Banned openers",
 * "Never open with") feeds the opener list. Every bullet under it, until the next heading of the
 * same or a higher level, is one entry. If a bullet holds quoted text, each quoted phrase is an
 * entry; otherwise the bullet text up to the first ":" or " (" is the entry.
 */
export function parseBannedFromVoiceMd(markdown: string): BannedLists {
  const openers: string[] = [];
  const phrases: string[] = [];
  let section: { level: number; kind: "opener" | "phrase" } | null = null;
  let inFence = false;

  for (const rawLine of normalizeQuotes(markdown).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      if (section && level > section.level) {
        // A sub-heading inside a banned section may switch its kind.
        if (OPENER_HEADING.test(text)) section = { level: section.level, kind: "opener" };
        continue;
      }
      section = null;
      if (OPENER_HEADING.test(text)) section = { level, kind: "opener" };
      else if (PHRASE_HEADING.test(text)) section = { level, kind: "phrase" };
      continue;
    }
    if (!section) continue;
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const entries = entriesFromBullet(bullet[1]!);
    (section.kind === "opener" ? openers : phrases).push(...entries);
  }
  return { openers: dedupe(openers), phrases: dedupe(phrases) };
}

function entriesFromBullet(text: string): string[] {
  const t = text.replace(/\*\*|__|`/g, "").trim();
  const quoted = [...t.matchAll(/"([^"]{1,80})"/g)].map((m) => m[1]!.trim());
  if (quoted.length > 0) return quoted.map(stripTrailingPunct).filter(Boolean);
  const head = t.split(/:\s|\s\(|\s-\s/)[0] ?? "";
  // A bullet with slashes lists alternatives: "gonna / wanna".
  return head
    .split(/\s+\/\s+|,\s+/)
    .map((s) => stripTrailingPunct(s.trim()))
    .filter((s) => s.length > 0 && s.length <= 80);
}

function stripTrailingPunct(s: string): string {
  return s.replace(/^['"]+|['".,;!?]+$/g, "").trim();
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const k = item.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/** Merges Brand Kit lists: `brand.yaml` bannedPhrases + voice.md lists. */
export function mergeBanned(...lists: Partial<BannedLists>[]): BannedLists {
  return {
    openers: dedupe(lists.flatMap((l) => l.openers ?? [])),
    phrases: dedupe(lists.flatMap((l) => l.phrases ?? [])),
  };
}

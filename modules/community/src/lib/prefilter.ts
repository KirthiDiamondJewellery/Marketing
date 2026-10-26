/**
 * No-AI prefilter for DMs and comments. Cheap rules decide what never needs a model:
 * spam, scams and threats; automation echoes (ours or other tools'); button taps and keyword-only messages;
 * conversations already answered; and messages that need no reply ("thanks", an emoji). Everything else is
 * `needs_review` and goes to the batched classifier. Pure and deterministic.
 */

export type PrefilterVerdict = "spam" | "auto" | "needs_review";
export type PrefilterReason =
  | "spam" | "no_typed_message" | "answered" | "no_reply_needed" | "keyword_only" | "automation" | "needs_review";

export type ThreadMessage = { id: string; direction: "in" | "out"; text: string; at: string };
export type Thread = { id: string; handle?: string; messages: ThreadMessage[] };

export type PrefilterRules = {
  spamPatterns?: readonly string[];
  automationLinkPatterns?: readonly string[];
  humanTypedLines?: readonly string[];
  /** Active comment keywords: a message that is just a keyword is an automation trigger, not a conversation. */
  keywords?: readonly string[];
  /** Our automation DM texts (normalised match marks outgoing echoes). */
  automationTexts?: readonly string[];
  /** Lines seen in this many threads count as templates. */
  templateThreads?: number;
};

const BUILTIN_SPAM = [
  "crypto", "bitcoin", "\\bbtc\\b", "forex", "binance", "usdt", "\\bnft\\b", "promote your (page|account)", "shout ?out for", "grow your (page|account|followers)",
  "real followers", "collab\\?? dm", "send it to @", "verify your account", "copyright (violation|infringement)", "meta support", "account (will be )?(disabled|suspended)",
  "onlyfans", "sugar (daddy|mommy|mama)", "cash ?app", "investment platform", "guaranteed (profit|returns)", "wire (me|the money)", "pay me or", "i will (report|expose|leak)",
];

/** Whole-message acknowledgements that need no reply. */
const ACK = "ok(ay)?|k+|thanks?|thank you|so much|a lot|ty|thx|got it|cool|nice|bet|sounds good|yes|yeah|yep|no|nope|lol|haha+|fire|hi+|hello|hey+|gm|amazing|awesome|love (it|this)|perfect|great|wow|appreciate (it|you)";
// A separator (or the end) is required after every token so untrusted text can't trigger catastrophic backtracking.
const NO_REPLY = new RegExp(`^(?:(?:${ACK})(?:[\\s!.,?]+|$))+$`, "i");
const needsNoReply = (text: string) => text.length <= 120 && NO_REPLY.test(text.trim());

export function normalise(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Emoji-, punctuation- or whitespace-only. */
export function isContentless(text: string): boolean {
  return normalise(text).length === 0;
}

function compile(patterns: readonly string[]): RegExp | undefined {
  const valid = patterns.filter((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  });
  return valid.length ? new RegExp(valid.map((p) => `(?:${p})`).join("|"), "i") : undefined;
}

export type CompiledRules = {
  spam: RegExp;
  automationLink?: RegExp;
  human: Set<string>;
  keywords: Set<string>;
  automationTexts: Set<string>;
  templates: Set<string>;
};

/** Lines (normalised) that recur across at least `minThreads` threads in this batch are templates (button taps, auto-replies). */
export function findTemplates(threads: readonly Thread[], minThreads = 5): Set<string> {
  const counts = new Map<string, number>();
  for (const t of threads) {
    const seen = new Set<string>();
    for (const m of t.messages) {
      const n = normalise(m.text);
      if (n.length < 4 || seen.has(`${m.direction}:${n}`)) continue;
      seen.add(`${m.direction}:${n}`);
      counts.set(`${m.direction}:${n}`, (counts.get(`${m.direction}:${n}`) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, c]) => c >= minThreads).map(([k]) => k));
}

export function compileRules(rules: PrefilterRules, threads: readonly Thread[] = []): CompiledRules {
  return {
    spam: compile([...BUILTIN_SPAM, ...(rules.spamPatterns ?? [])])!,
    ...(compile(rules.automationLinkPatterns ?? []) ? { automationLink: compile(rules.automationLinkPatterns ?? [])! } : {}),
    human: new Set((rules.humanTypedLines ?? []).map(normalise)),
    keywords: new Set((rules.keywords ?? []).map(normalise)),
    automationTexts: new Set((rules.automationTexts ?? []).map(normalise)),
    templates: findTemplates(threads, rules.templateThreads ?? 5),
  };
}

/** Is this one message "real" (typed by a person and meaningful), from its direction's point of view? */
export function isRealMessage(m: ThreadMessage, r: CompiledRules): boolean {
  const n = normalise(m.text);
  if (!n) return false;
  if (r.human.has(n)) return true;
  if (r.templates.has(`${m.direction}:${n}`)) return false;
  if (m.direction === "out") {
    if (r.automationTexts.has(n)) return false;
    if (r.automationLink?.test(m.text)) return false;
    return true;
  }
  if (r.keywords.has(n)) return false; // a keyword typed to trigger an automation
  return true;
}

export type ThreadVerdict = {
  verdict: PrefilterVerdict;
  reason: PrefilterReason;
  /** Their last real message (what the reply would answer). */
  lastMessage?: ThreadMessage;
  /** First real incoming message after our last real reply. */
  waitingSince?: string;
  /** We have replied by hand at some point. */
  everReplied: boolean;
};

export function prefilterThread(thread: Thread, r: CompiledRules): ThreadVerdict {
  const msgs = [...thread.messages].sort((a, b) => a.at.localeCompare(b.at));
  const realIn = msgs.filter((m) => m.direction === "in" && isRealMessage(m, r));
  const realOut = msgs.filter((m) => m.direction === "out" && isRealMessage(m, r));
  const everReplied = realOut.length > 0;
  const allIncoming = msgs.filter((m) => m.direction === "in").map((m) => m.text).join("\n");
  if (allIncoming && r.spam.test(allIncoming)) return { verdict: "spam", reason: "spam", everReplied };
  const last = realIn.at(-1);
  if (!last) {
    const keywordOnly = msgs.some((m) => m.direction === "in" && r.keywords.has(normalise(m.text)));
    return { verdict: "auto", reason: keywordOnly ? "keyword_only" : msgs.some((m) => m.direction === "in") ? "automation" : "no_typed_message", everReplied };
  }
  const lastOut = realOut.at(-1);
  if (lastOut && lastOut.at > last.at) return { verdict: "auto", reason: "answered", lastMessage: last, everReplied };
  const waiting = realIn.filter((m) => !lastOut || m.at > lastOut.at);
  const waitingSince = waiting[0]?.at ?? last.at;
  if ((needsNoReply(last.text) || isContentless(last.text)) && (realIn.length === 1 || everReplied)) {
    return { verdict: "auto", reason: "no_reply_needed", lastMessage: last, waitingSince, everReplied };
  }
  return { verdict: "needs_review", reason: "needs_review", lastMessage: last, waitingSince, everReplied };
}

/** Comments: spam, keyword-only (the automation handles those), and contentless/acknowledgement comments need no reply. */
export function prefilterComment(text: string, r: CompiledRules): { verdict: PrefilterVerdict; reason: PrefilterReason } {
  if (r.spam.test(text)) return { verdict: "spam", reason: "spam" };
  const n = normalise(text);
  if (!n) return { verdict: "auto", reason: "no_reply_needed" };
  if (r.keywords.has(n) || [...r.keywords].some((k) => n.split(" ").every((w) => w === k))) return { verdict: "auto", reason: "keyword_only" };
  return { verdict: "needs_review", reason: "needs_review" };
}

export type Temperature = "hot" | "warm" | "cold";

/** Hot → Warm after hotDays, Warm → Cold after warmDays (counted from when they started waiting). Never moves up. */
export function ageTemperature(t: Temperature, waitingSince: Date, now: Date, opts: { hotDays: number; warmDays: number }): Temperature {
  const days = (now.getTime() - waitingSince.getTime()) / 86_400_000;
  if (t === "hot" && days > opts.hotDays) t = days > opts.warmDays ? "cold" : "warm";
  if (t === "warm" && days > opts.warmDays) t = "cold";
  return t;
}

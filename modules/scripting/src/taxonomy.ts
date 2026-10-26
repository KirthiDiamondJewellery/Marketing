/**
 * Named hook-pattern taxonomy. Generic and niche-free: each pattern has a definition, an abstract
 * template with [placeholders], and cheap regex cues for the pre-classifier. No real hooks are stored
 * here; banks hold the user's own openers and harvested competitor openers.
 */

export type HookPattern = {
  id: string;
  name: string;
  definition: string;
  /** Abstract shape; placeholders in [brackets]. Copy the structure, never anyone's words. */
  template: string;
  /** When the pattern tends to fit. */
  whenToUse: string;
  /** Pre-classifier cues, tested against the first sentence. Order in HOOK_PATTERNS sets priority. */
  cues: RegExp[];
};

export const HOOK_PATTERNS: readonly HookPattern[] = [
  {
    id: "question-objection",
    name: "The question I keep getting",
    definition: "Opens with a question real customers ask, then promises the straight answer.",
    template: "[Audience] keep asking me [specific question]. [The short answer].",
    whenToUse: "FAQ and objection content from the proof inventory.",
    cues: [/\b(people|clients|customers|homeowners|owners|everyone|you guys) (keep |always )?ask(ing|ed)? me\b/i, /\bi (always |keep )?get asked\b/i, /\bthe (number one |#1 )?question i get\b/i],
  },
  {
    id: "list-instant-reveal",
    name: "List with instant reveal",
    definition: "Announces a short list and reveals item one immediately instead of holding it back.",
    template: "[N] [things] that [outcome]. Number one: [first item].",
    whenToUse: "Roundups and checklists where each item stands alone.",
    cues: [/^\s*(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+[\p{L}'-]+(\s+[\p{L}'-]+){0,3}\s+(that|to|you|i|every|for|which|we)\b/iu, /\bnumber one\b/i],
  },
  {
    id: "qualifier-callout",
    name: "Qualifier callout",
    definition: "Names exactly who it's for in one clause, then makes the claim.",
    template: "If you [situation or identity], [claim that matters to them].",
    whenToUse: "Narrow offers and lanes aimed at one buyer type.",
    cues: [/^\s*if you('re| are| have| run| own| just)?\b/i],
  },
  {
    id: "result-receipt",
    name: "I did X, got Y",
    definition: "A first-person action with a specific, checkable result. Line two pivots to the viewer.",
    template: "I [did a specific thing] and [specific result].",
    whenToUse: "Case studies, builds and experiments with a recorded outcome.",
    cues: [/^\s*(i|we)\s+(just\s+)?(built|made|tested|tried|spent|ran|gave|saved|got|grew|tracked|booked|closed|fixed|helped|finished|rebuilt|redesigned)\b/i],
  },
  {
    id: "before-after",
    name: "Before and after",
    definition: "Shows the gap between a starting state and an end state, with the time it took.",
    template: "[Before state] to [after state] in [timeframe].",
    whenToUse: "Transformations: projects, clients, systems.",
    cues: [/\bfrom\b.{1,50}\bto\b.{1,50}\b(in|within|after)\b/i, /\bbefore\b.{1,60}\bafter\b/i],
  },
  {
    id: "story-open",
    name: "Story open",
    definition: "Drops the viewer into a specific moment with a time and a person.",
    template: "[Specific time], [person] [did or said something unexpected].",
    whenToUse: "Behind-the-scenes and lessons with a real moment.",
    cues: [/^\s*(last (week|month|year|night|tuesday|monday|wednesday|thursday|friday|saturday|sunday)|yesterday|this morning|today a|(two|three|four|five|\d+) (years|months|weeks|days) ago|a (client|customer|homeowner|buyer) (told|called|asked|sent|showed))\b/i],
  },
  {
    id: "myth-bust",
    name: "Myth bust",
    definition: "Names a belief the audience holds and says it's false, with the reason held for the body.",
    template: "[Common belief] is a myth. [Hint at what's actually true].",
    whenToUse: "Correcting a costly misconception in the niche.",
    cues: [/\bmyth\b/i, /\bisn'?t (actually )?true\b/i, /\bis a lie\b/i, /\bstop believing\b/i],
  },
  {
    id: "contrarian",
    name: "Contrarian claim",
    definition: "Takes the opposite side of conventional advice, concretely.",
    template: "[Conventional advice] is [wrong or overrated]. [What to do instead].",
    whenToUse: "When the brand has an earned, defensible opinion.",
    cues: [/\b(is|are) (wrong|overrated|dead|a waste|backwards|a trap)\b/i, /\bunpopular opinion\b/i, /\beveryone (says|thinks|tells you)\b/i, /^\s*stop\b/i],
  },
  {
    id: "cost-of-mistake",
    name: "Cost of the mistake",
    definition: "Names one specific mistake and what it costs, in money, time or outcomes.",
    template: "[Specific mistake] costs [audience] [concrete cost].",
    whenToUse: "Problem-aware audiences; pairs well with proof numbers.",
    cues: [/\b(costs?|costing|losing|lose|lost|wasting|wastes?|blows?|breaks?|kills?)\b.{0,50}(\$|\d|money|budget|thousands|hours|clients|leads|deals|jobs)/i],
  },
  {
    id: "stakes-warning",
    name: "Check this first",
    definition: "Warns about one checkable thing before a decision, tied to a concrete mechanism (never vague dread).",
    template: "Before you [decision], check [specific thing].",
    whenToUse: "Buying decisions and contracts, with a mechanism the viewer can verify.",
    cues: [/^\s*(before you|don'?t (sign|hire|buy|start|pay|book|choose))\b/i],
  },
  {
    id: "comparison",
    name: "Versus",
    definition: "Puts two options side by side and promises which one wins and when.",
    template: "[Option A] or [option B]: [which wins for whom].",
    whenToUse: "Choice points the audience is stuck on.",
    cues: [/\bvs\.?\b|\bversus\b/i, /\bor\b.{1,40}\bwhich (one )?(is|wins|should)\b/i],
  },
  {
    id: "how-to-outcome",
    name: "How to get the outcome without the pain",
    definition: "Promises a specific outcome and removes the usual cost of getting it.",
    template: "How to [specific outcome] without [common pain].",
    whenToUse: "Tutorials and process content; keep the outcome specific.",
    cues: [/^\s*how (to|i|we)\b/i],
  },
  {
    id: "social-proof-number",
    name: "Number first",
    definition: "Leads with a real, sourced number that makes the claim credible on its own.",
    template: "[Number] [people or things] [did something surprising].",
    whenToUse: "When the proof inventory has a striking, recorded number.",
    cues: [/^\s*\$?\d[\d,.]*\s*(%|k\b|percent|people|clients|customers|homeowners|businesses|owners|projects|leads|calls|jobs)/i],
  },
  {
    id: "insider-truth",
    name: "What insiders know",
    definition: "Reveals something people inside the industry know, and names the thing in the same breath.",
    template: "What [insiders] know about [named thing] that [audience] doesn't.",
    whenToUse: "Expertise content; must name the thing, never a vague tease.",
    cues: [/\b(nobody|no one) (tells|talks|knows|mentions)\b/i, /\bwhat (\w+ )?(won'?t|don'?t|never) tell you\b/i, /\bthe (real )?reason\b/i, /\bsecret\b/i],
  },
  {
    id: "direct-question",
    name: "Direct question",
    definition: "Asks the viewer a question they want answered, with stakes in the question.",
    template: "Why does [specific pain] keep happening to [audience]?",
    whenToUse: "When the pain is common and specific.",
    cues: [/^[^.!?]{3,140}\?/],
  },
  {
    id: "pov-identity",
    name: "POV identity",
    definition: "Puts the viewer in a situation they recognize from their own day.",
    template: "You're [identity] and [relatable, specific situation].",
    whenToUse: "Relatable lanes and community building.",
    cues: [/^\s*(pov\b|you'?re (a|an|the|still)\b)/i],
  },
];

export const HOOK_PATTERN_IDS: readonly string[] = HOOK_PATTERNS.map((p) => p.id);
export const UNCLASSIFIED = "unclassified";

export function getPattern(id: string): HookPattern | undefined {
  return HOOK_PATTERNS.find((p) => p.id === id);
}

/**
 * Cheap regex pre-classifier. Looks at the first sentence and returns the first pattern whose cue matches,
 * or null when nothing fits (the LLM classifier handles those).
 */
export function preClassifyHook(text: string): { pattern: string; cue: string } | null {
  const first = (text.trim().replace(/[‘’]/g, "'").split(/(?<=[.!?])\s+/)[0] ?? "").trim();
  if (!first) return null;
  for (const p of HOOK_PATTERNS) {
    for (const cue of p.cues) {
      const m = cue.exec(first);
      if (m) return { pattern: p.id, cue: m[0] };
    }
  }
  return null;
}

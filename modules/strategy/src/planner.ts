import { makeRemixOf, remixTitle, type CtaType, type FunnelStage, type ProofItem, type RemixOf } from "@attentionos/core";
import { contentWords, jaccard, pickWeighted, seededRandom, weightOf, type FeatureWeights } from "@attentionos/scoring";
import type { IdeaKind, Lane, StoryStructure } from "./pillars.ts";

/**
 * The deterministic "Film today" planner. Same inputs and seed → same slate. It decides WHAT to
 * film (lane, funnel stage, angle, structure, template, CTA, sources, deadline); the Copywriter decides the words.
 *
 * Rules, in order:
 * - Lanes are filled by weekly deficit (quota minus what's already planned this week), times learn weights.
 * - Funnel stages that are behind the target mix over the last N pieces get a boost.
 * - Topic cooldown: nothing too close (shared content words) to a recent piece or a rejected concept.
 * - Angles rotate with a cooldown; about one idea in three gets a story structure (least recently used).
 * - Templates rotate (least recently used for that kind), so the week doesn't look like one video.
 * - Proof items rotate with a cooldown and are the ONLY source of numbers.
 * - Exploration: a share of weighted picks ignores the weights (seeded, so still deterministic).
 * - Remixes come first in spirit: most slots remake a proven post (ranked in remix.ts), keeping its structure and
 *   carrying a proof item so the Copywriter swaps in the owner's numbers, never the source's.
 */

export const DEFAULT_TEMPLATES: Record<IdeaKind, string[]> = {
  news: ["news-greenscreen"],
  remix: ["split-demo", "raw-talking-head", "popup-presenter"],
  talking_head: ["raw-talking-head", "popup-presenter"],
  offer: ["raw-talking-head"],
};

export const DEFAULT_CTA_BY_STAGE: Record<FunnelStage, CtaType> = { tofu: "follow", mofu: "comment_keyword", bofu: "book_call" };

export type RecentPiece = {
  title: string;
  lane: string | null;
  funnelStage: FunnelStage | null;
  angle: string | null;
  template: string | null;
  storyStructure: string | null;
  createdAt: string;
  sourceIds: string[];
  /** Proven posts this piece has taken for a remix (see repo `recentPieces`). Defaults to `sourceIds`. */
  remixSourceIds?: string[];
};

/** `header` is the validated kit header (LLM output that passed the kit checks), never the raw trend title. */
export type TrendCandidate = { id: string; url: string; heat: number; header: string | null; filmBy?: string | null; hasKit: boolean };
export type OutlierCandidate = {
  id: string;
  url: string;
  creator: string;
  platform: string;
  x: number;
  hookPattern?: string | null;
  format?: string | null;
  views?: number | null;
  /** The owner's own breakout rather than a competitor's outlier. */
  own?: boolean;
  /** From the checked remix blueprint: what the post is about. */
  topic?: string | null;
  /** Remix ranking score (remix.ts); higher goes first. Falls back to x. */
  score?: number;
};
export type ProofCandidate = Pick<ProofItem, "id" | "kind" | "title" | "summary" | "numbers" | "clientConsent"> & { lastUsedAt: string | null };

export type PlannerInput = {
  mode: "daily" | "batch";
  now: Date;
  /** Seed for exploration; `${workspaceId}:${date}:${mode}` keeps a day's plan stable. */
  seed: string;
  slots: Record<IdeaKind, number>;
  lanes: Lane[];
  /** Pieces already planned or made this week, per lane id. */
  laneCountsThisWeek: Record<string, number>;
  funnelTarget: Record<FunnelStage, number>;
  /** Funnel stages of the last N pieces, newest first. */
  recentFunnel: FunnelStage[];
  mainAngle: string | null;
  angles: { id: string; text: string }[];
  storyStructures: StoryStructure[];
  /** Newest first. */
  recent: RecentPiece[];
  rejected: string[];
  trends: TrendCandidate[];
  outliers: OutlierCandidate[];
  proof: ProofCandidate[];
  offers: { id: string; name: string; cta: CtaType }[];
  templates: Partial<Record<IdeaKind, string[]>>;
  ctaByStage: Partial<Record<FunnelStage, CtaType>>;
  weights: FeatureWeights;
  explore: number;
  cooldowns: { topicDays: number; proofDays: number; angleDays: number };
  filmBy: { newsHours: number; defaultHours: number };
  storyShare: number;
};

export type SourceRef = { type: "trend" | "external_post" | "proof" | "offer"; id: string; url?: string };

export type SlateItem = {
  slot: number;
  kind: IdeaKind;
  title: string;
  lane: string;
  laneName: string;
  funnelStage: FunnelStage;
  angle: string | null;
  storyStructure: string | null;
  template: string;
  ctaType: CtaType;
  sourceRefs: SourceRef[];
  filmBy: string;
  /** Plain-language reason this piece is on the slate. */
  why: string;
  proof?: { id: string; title: string; numbers: { value: string; label: string; source: string }[]; clientConsent: boolean };
  /** Remixes: the proven post this piece remakes. */
  remixOf?: RemixOf;
};

export type PlanResult = { items: SlateItem[]; notes: string[] };

const H = 3_600_000;
const D = 24 * H;

const KIND_ORDER: IdeaKind[] = ["news", "remix", "talking_head", "offer"];

export function planSlate(input: PlannerInput): PlanResult {
  const rand = seededRandom(input.seed);
  const now = input.now.getTime();
  const notes: string[] = [];
  const items: SlateItem[] = [];
  const laneCounts = { ...input.laneCountsThisWeek };
  const funnel = [...input.recentFunnel];

  const recentTopics = input.recent
    .filter((r) => now - new Date(r.createdAt).getTime() <= input.cooldowns.topicDays * D)
    .map((r) => contentWords(`${r.title} ${r.angle ?? ""}`));
  const rejectedTopics = input.rejected.map((r) => contentWords(r));
  const usedSources = new Set(input.recent.flatMap((r) => r.sourceIds));
  // Proven posts already taken for a remix (falls back to everything a piece cited when that isn't known).
  const remixedSources = new Set(input.recent.flatMap((r) => r.remixSourceIds ?? r.sourceIds));
  const plannedTopics: string[][] = [];
  const tooClose = (text: string) => {
    const words = contentWords(text);
    if (words.length === 0) return false;
    return [...recentTopics, ...plannedTopics].some((t) => jaccard(words, t) >= 0.5)
      || rejectedTopics.some((t) => t.length > 0 && (jaccard(words, t) >= 0.5 || t.every((w) => words.includes(w))));
  };

  const deficit = (l: Lane) => Math.max(0, l.weeklyQuota - (laneCounts[l.id] ?? 0));
  const funnelNeed = (stage: FunnelStage) => {
    const n = funnel.length;
    const actual = n === 0 ? 0 : (funnel.filter((f) => f === stage).length / n) * 100;
    return 1 + Math.max(0, (input.funnelTarget[stage] - actual) / 100) * 2;
  };

  function pickLane(kind: IdeaKind): Lane | null {
    const fits = input.lanes.filter((l) => l.kinds.includes(kind));
    if (fits.length === 0) return null;
    const options = fits.map((l) => ({ lane: l, weight: (deficit(l) + 0.25) * funnelNeed(l.funnelStage) * weightOf(input.weights, "lane", l.id) }));
    const open = options.filter((o) => deficit(o.lane) > 0);
    return (pickWeighted(open.length ? open : options, rand, input.explore) ?? options[0]!).lane;
  }

  const lastUsed = (field: "angle" | "template" | "storyStructure", value: string) => {
    const idx = [...items].reverse().findIndex((i) => (field === "angle" ? i.angle : field === "template" ? i.template : i.storyStructure) === value);
    if (idx !== -1) return now + 1; // used in this slate: most recent of all
    const r = input.recent.find((p) => p[field] === value);
    return r ? new Date(r.createdAt).getTime() : 0;
  };

  function pickAngle(): string | null {
    const all = input.angles.length ? input.angles.map((a) => a.text) : input.mainAngle ? [input.mainAngle] : [];
    if (all.length === 0) return null;
    const cooled = all.filter((a) => now - lastUsed("angle", a) > input.cooldowns.angleDays * D);
    const pool = (cooled.length ? cooled : all).map((a) => ({ a, weight: weightOf(input.weights, "angle", a) / (1 + (lastUsed("angle", a) > 0 ? 1 : 0)) }));
    return pickWeighted(pool, rand, input.explore)!.a;
  }

  function pickTemplate(kind: IdeaKind): string {
    const list = input.templates[kind]?.length ? input.templates[kind]! : DEFAULT_TEMPLATES[kind];
    // Least recently used first; learn weights for "format" break ties.
    return [...list].sort((a, b) => lastUsed("template", a) - lastUsed("template", b) || weightOf(input.weights, "format", b) - weightOf(input.weights, "format", a) || list.indexOf(a) - list.indexOf(b))[0]!;
  }

  function pickStructure(): string | null {
    if (input.storyStructures.length === 0 || rand() >= input.storyShare) return null;
    return [...input.storyStructures].sort((a, b) => lastUsed("storyStructure", a.id) - lastUsed("storyStructure", b.id) || weightOf(input.weights, "story_structure", b.id) - weightOf(input.weights, "story_structure", a.id))[0]!.id;
  }

  const proofUsed = new Set<string>();
  function pickProof(kinds: string[]): ProofCandidate | null {
    if (kinds.length === 0) return null;
    const ok = input.proof.filter((p) => kinds.includes(p.kind) && !proofUsed.has(p.id) && (!p.lastUsedAt || now - new Date(p.lastUsedAt).getTime() > input.cooldowns.proofDays * D));
    // Never used first, then least recently used; inventory order breaks ties (stable).
    const p = [...ok].sort((a, b) => (a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0) - (b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0))[0];
    if (p) proofUsed.add(p.id);
    return p ?? null;
  }

  const ctaFor = (stage: FunnelStage): CtaType => input.ctaByStage[stage] ?? DEFAULT_CTA_BY_STAGE[stage];
  const filmBy = (hours: number, cap?: string | null) => {
    const t = now + hours * H;
    return new Date(cap ? Math.min(t, new Date(cap).getTime()) : t).toISOString();
  };

  function add(kind: IdeaKind, lane: Lane, partial: Omit<SlateItem, "slot" | "kind" | "lane" | "laneName" | "funnelStage" | "template" | "storyStructure" | "angle" | "ctaType"> & { angle?: string | null; ctaType?: CtaType; storyStructure?: string | null }) {
    const item: SlateItem = {
      slot: items.length + 1,
      kind,
      lane: lane.id,
      laneName: lane.name,
      funnelStage: lane.funnelStage,
      template: pickTemplate(kind),
      angle: partial.angle === undefined ? pickAngle() : partial.angle,
      storyStructure: partial.storyStructure === undefined ? pickStructure() : partial.storyStructure,
      ctaType: partial.ctaType ?? ctaFor(lane.funnelStage),
      ...partial,
    } as SlateItem;
    items.push(item);
    laneCounts[lane.id] = (laneCounts[lane.id] ?? 0) + 1;
    funnel.unshift(lane.funnelStage);
    plannedTopics.push(contentWords(`${item.title} ${item.angle ?? ""}`));
  }

  // Proven posts first: the pool comes ranked (views, times-normal, recency, niche, blueprint ready).
  const remixPool = [...input.outliers].sort((a, b) => (b.score ?? b.x) - (a.score ?? a.x) || b.x - a.x || a.id.localeCompare(b.id));
  function addRemixes(want: number): number {
    let made = 0;
    for (const o of remixPool) {
      if (made >= want) break;
      if (remixedSources.has(o.id)) continue;
      if (o.topic && tooClose(o.topic)) continue;
      // A remix is a talking-head-style piece too, so lanes built for talking heads can carry one.
      const lane = pickLane("remix") ?? pickLane("talking_head");
      if (!lane) break;
      const remixOf = makeRemixOf({ externalPostId: o.id, url: o.url, handle: o.creator, platform: o.platform, own: Boolean(o.own), views: o.views ?? null, x: o.x });
      remixedSources.add(o.id);
      usedSources.add(o.id);
      add("remix", lane, {
        title: remixTitle({ topic: o.topic, own: Boolean(o.own), handle: remixOf.handle, platform: o.platform, views: o.views ?? null }),
        angle: null,
        storyStructure: null,
        sourceRefs: [{ type: "external_post", id: o.id, url: o.url }],
        filmBy: filmBy(input.filmBy.defaultHours),
        why: `${remixOf.line}. Same hook, beats and format; your topic, proof and words.`,
        remixOf,
      });
      made++;
    }
    return made;
  }

  for (const kind of KIND_ORDER) {
    const want = input.slots[kind];
    if (want <= 0) continue;
    let made = 0;

    if (kind === "news") {
      // Only stories with a validated kit: a raw trend title is untrusted text and never becomes a content title.
      const pool = input.trends.filter((t) => t.hasKit && t.header).sort((a, b) => b.heat - a.heat || a.id.localeCompare(b.id));
      for (const t of pool) {
        if (made >= want) break;
        const title = t.header!;
        if (usedSources.has(t.id) || tooClose(title)) continue;
        const lane = pickLane("news") ?? pickLane("talking_head");
        if (!lane) break;
        add("news", lane, {
          title,
          angle: null,
          storyStructure: null,
          sourceRefs: [{ type: "trend", id: t.id, url: t.url }],
          filmBy: filmBy(input.filmBy.newsHours, t.filmBy),
          why: `Hot story (heat ${t.heat}) with a ready kit; news fades after about two days`,
        });
        made++;
      }
    }

    if (kind === "remix") made += addRemixes(want);

    if (kind === "talking_head") {
      let guard = 0;
      while (made < want && guard++ < want * 4) {
        const lane = pickLane("talking_head");
        if (!lane) break;
        const proof = pickProof(lane.proofKinds);
        const angle = pickAngle();
        const title = proof ? proof.title : angle ?? lane.name;
        if (tooClose(`${title} ${angle ?? ""}`) && guard < want * 4) {
          // Count the lane as touched so the next pick moves on, then try again.
          laneCounts[lane.id] = (laneCounts[lane.id] ?? 0) + 0.5;
          continue;
        }
        add("talking_head", lane, {
          title,
          angle,
          sourceRefs: proof ? [{ type: "proof", id: proof.id }] : [],
          filmBy: filmBy(input.filmBy.defaultHours),
          why: `${lane.name} is ${deficit(lane)} short of its weekly quota` + (proof ? `; built on "${proof.title}" from the proof inventory` : ""),
          ...(proof ? { proof: { id: proof.id, title: proof.title, numbers: proof.numbers, clientConsent: proof.clientConsent } } : {}),
        });
        made++;
      }
    }

    if (kind === "offer") {
      const lane = pickLane("offer") ?? input.lanes.find((l) => l.funnelStage === "bofu") ?? null;
      for (let i = 0; i < want && lane; i++) {
        const offer = input.offers[i % Math.max(1, input.offers.length)];
        const proof = pickProof(["case_study", "client_win", ...lane.proofKinds]);
        add("offer", lane, {
          title: offer ? `Offer: ${offer.name}` : `Offer: ${lane.name}`,
          ...(offer ? { ctaType: offer.cta } : {}),
          sourceRefs: [...(offer ? [{ type: "offer" as const, id: offer.id }] : []), ...(proof ? [{ type: "proof" as const, id: proof.id }] : [])],
          filmBy: filmBy(input.filmBy.defaultHours),
          why: offer ? "The weekly ask: one clear next step" : "The weekly ask (no offer in brand.yaml yet)",
          ...(proof ? { proof: { id: proof.id, title: proof.title, numbers: proof.numbers, clientConsent: proof.clientConsent } } : {}),
        });
        made++;
      }
    }

    if (made < want) notes.push(`${want - made} ${kind.replace("_", " ")} slot${want - made === 1 ? "" : "s"} left open: ${
      kind === "news" ? "no fresh story on the trend desk" : kind === "remix" ? "no new outliers to remix" : kind === "offer" ? "no offer lane" : "nothing outside the topic cooldown"}`);
  }

  // Backfill empty slots with more proven posts first, then talking heads, so the slate keeps its size.
  if (Object.values(input.slots).reduce((s, n) => s + n, 0) > items.length) addRemixes(Object.values(input.slots).reduce((s, n) => s + n, 0) - items.length);
  const shortBy = Object.values(input.slots).reduce((s, n) => s + n, 0) - items.length;
  for (let i = 0, guard = 0; i < shortBy && guard < shortBy * 4; guard++) {
    const lane = pickLane("talking_head");
    if (!lane) break;
    const angle = pickAngle();
    const proof = pickProof(lane.proofKinds);
    const title = proof ? proof.title : angle ?? lane.name;
    if (tooClose(`${title} ${angle ?? ""}`)) {
      laneCounts[lane.id] = (laneCounts[lane.id] ?? 0) + 0.5;
      continue;
    }
    add("talking_head", lane, {
      title, angle,
      sourceRefs: proof ? [{ type: "proof", id: proof.id }] : [],
      filmBy: filmBy(input.filmBy.defaultHours),
      why: `Filling an open slot: ${lane.name} is behind on its weekly quota`,
      ...(proof ? { proof: { id: proof.id, title: proof.title, numbers: proof.numbers, clientConsent: proof.clientConsent } } : {}),
    });
    i++;
  }
  // Remixes get the proof left over once the original pieces have theirs: the owner's numbers to swap in for the
  // source creator's.
  for (const item of items) {
    if (item.kind !== "remix" || item.proof) continue;
    const lane = input.lanes.find((l) => l.id === item.lane);
    const proof = pickProof(lane?.proofKinds ?? []);
    if (!proof) continue;
    item.proof = { id: proof.id, title: proof.title, numbers: proof.numbers, clientConsent: proof.clientConsent };
    item.sourceRefs.push({ type: "proof", id: proof.id });
  }

  const stillShort = Object.values(input.slots).reduce((s, n) => s + n, 0) - items.length;
  if (stillShort > 0) notes.push(`${stillShort} slot${stillShort === 1 ? "" : "s"} couldn't be backfilled without repeating a recent topic: add sub-angles to brand/pillars.md or items to brand/proof-inventory.yaml`);
  return { items, notes };
}

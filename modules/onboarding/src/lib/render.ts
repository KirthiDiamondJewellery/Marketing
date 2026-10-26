import { stringify } from "yaml";
import type { Competitor, ProofItem, TrendSourceConfig } from "@attentionos/core";
import { patchYaml, readSection, slugify, upsertSection } from "./brand-files.ts";
import type { BusinessDraft, InterviewAnswer, VoiceDraft } from "./state.ts";

/**
 * Deterministic renderers: agents return structured drafts, the owner edits them as cards, and these functions turn
 * the approved drafts into Brand Kit files that keep the starter files' layout. No brand words live here; every
 * value comes from the owner's approved draft.
 */

const bullets = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`).join("\n");
const quoted = (xs: string[]) => xs.map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).map((x) => `- "${x}"`).join("\n");
const or = (text: string, fallback: string) => (text.trim() ? text.trim() : fallback);
const TODO = (hint: string) => `<!-- TODO: ${hint} -->`;

export function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** brand.yaml fields from the approved business draft (comments in the file are kept). */
export function brandYamlFromBusiness(current: string, draft: BusinessDraft): string {
  const offers = draft.offers.map((o) => ({ id: o.id, name: o.name, ...(isHttpUrl(o.url) ? { url: o.url } : {}), cta: o.cta }));
  return patchYaml(current, {
    name: draft.name,
    oneLiner: draft.oneLiner,
    website: isHttpUrl(draft.website) ? draft.website : undefined,
    offers,
    ...(isHttpUrl(draft.website) ? { "cta.siteUrl": draft.website } : {}),
  });
}

export function offersMd(current: string, draft: BusinessDraft): string {
  const sections = draft.offers.length
    ? draft.offers
        .map((o) =>
          [
            `### ${o.name}`,
            `- Who it's for: ${o.whoFor.trim()}`,
            `- What they get: ${o.whatTheyGet.trim()}`,
            ...(o.price.trim() ? [`- Price or price range: ${o.price.trim()}`] : []),
            `- How to start: ${or(o.howToStart, o.cta.replace(/_/g, " "))}`,
            ...(isHttpUrl(o.url) ? [`- Link: ${o.url}`] : []),
          ].join("\n"),
        )
        .join("\n\n")
    : TODO("one section per offer");
  let md = current.trim() ? current : "# What we sell\n";
  md = upsertSection(md, "Offers", sections);
  md = upsertSection(md, "Results we may claim", [
    "Only results listed here, or in `proof-inventory.yaml` with a source, may appear in content. Agents never invent numbers.",
    "",
    draft.claimableResults.length ? bullets(draft.claimableResults) : TODO("results you can back up, with where the evidence lives"),
  ].join("\n"));
  md = upsertSection(md, "Things we never promise", draft.neverPromise.length ? bullets(draft.neverPromise) : TODO("e.g. guaranteed outcomes or timelines you can't control"));
  return `${md.trimEnd()}\n`;
}

export function icpMd(current: string, draft: BusinessDraft): string {
  const a = draft.audience;
  let md = current.trim() ? current : "# Who we talk to\n";
  md = upsertSection(md, "The person", or(a.who, TODO("who they are")));
  md = upsertSection(md, "What they want", or(a.wants, TODO("the result they hope for, in their words")));
  md = upsertSection(md, "What keeps them stuck", or(a.stuck, TODO("problems, fears and bad experiences")));
  md = upsertSection(md, "What they say (real quotes)", a.quotes.length ? quoted(a.quotes) : TODO("5 to 15 short, anonymous quotes from calls, DMs or reviews"));
  md = upsertSection(md, "Objections we hear", a.objections.length ? bullets(a.objections) : TODO("reasons people give for not buying, and your answer"));
  md = upsertSection(md, "Who it's not for", or(a.notFor, TODO("people you don't want to attract")));
  return `${md.trimEnd()}\n`;
}

/** Adds the interview's answers to icp.md without dropping what is already there. */
export function icpMdWithAnswers(current: string, answers: InterviewAnswer[]): string {
  const add = (md: string, heading: string, lines: string[], format: (xs: string[]) => string) => {
    if (!lines.length) return md;
    const existing = readSection(md, heading);
    const fresh = lines.filter((l) => !existing.includes(l.trim()));
    if (!fresh.length) return md;
    return upsertSection(md, heading, [existing, format(fresh)].filter(Boolean).join("\n"));
  };
  const of = (k: InterviewAnswer["kind"]) => answers.filter((a) => a.kind === k).map((a) => a.text);
  let md = current.trim() ? current : "# Who we talk to\n";
  md = add(md, "What they want", of("want"), bullets);
  md = add(md, "What keeps them stuck", of("pain"), bullets);
  md = add(md, "What they say (real quotes)", of("quote"), quoted);
  md = add(md, "Objections we hear", of("objection"), bullets);
  md = add(md, "Who it's not for", of("not_for"), bullets);
  return `${md.trimEnd()}\n`;
}

const PROOF_KIND: Partial<Record<InterviewAnswer["kind"], ProofItem["kind"]>> = {
  proof: "client_win",
  faq: "faq",
  objection: "objection",
  process: "process",
  story: "story",
};

/** Proof items from interview answers, merged into the existing inventory by id. Numbers always carry a source. */
export function proofInventoryWithAnswers(currentItems: ProofItem[], answers: InterviewAnswer[], today: string): ProofItem[] {
  const items = [...currentItems];
  const ids = new Set(items.map((i) => i.id));
  for (const a of answers) {
    const kind = PROOF_KIND[a.kind];
    if (!kind) continue;
    const title = a.text.split(/(?<=[.!?])\s/)[0]!.slice(0, 90).trim();
    if (items.some((i) => i.summary === a.text.trim())) continue;
    let id = slugify(`${kind}-${title}`, 48);
    for (let n = 2; ids.has(id); n++) id = `${slugify(`${kind}-${title}`, 44)}-${n}`;
    ids.add(id);
    items.push({
      id,
      kind,
      title,
      summary: a.text.trim(),
      numbers: a.numbers.filter((n) => n.source.trim()).map((n) => ({ value: n.value, label: n.label, source: n.source })),
      clientConsent: a.clientConsent,
      tags: ["onboarding", today],
    });
  }
  return items;
}

const PROOF_HEADER = [
  "# Your proof inventory: case studies, client wins, FAQs, objections, processes and stories.",
  "#",
  "# This is the ONLY place numbers may come from in proof content. If a number isn't here",
  "# (with a source), agents won't use it.",
  "#",
  "# kind options: case_study, client_win, faq, objection, process, build, story, stat",
  "# clientConsent: set to true only if the client agreed to be named.",
  "",
].join("\n");

export function proofInventoryYaml(items: ProofItem[]): string {
  const clean = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    summary: i.summary,
    numbers: i.numbers,
    clientConsent: i.clientConsent,
    ...(i.lastUsedAt ? { lastUsedAt: i.lastUsedAt } : {}),
    tags: i.tags,
  }));
  return `${PROOF_HEADER}${stringify({ items: clean }, { lineWidth: 0 })}`;
}

export function voiceMd(current: string, draft: VoiceDraft): string {
  let md = current.trim() ? current : "# How we sound\n";
  md = upsertSection(md, "In one line", or(draft.oneLine, TODO("one line on how you sound")));
  md = upsertSection(md, "How we talk", draft.howWeTalk.length ? bullets(draft.howWeTalk) : TODO("filled in from your transcripts"));
  md = upsertSection(md, "Signature moves", draft.signatureMoves.length ? bullets(draft.signatureMoves) : TODO("things people recognise you by"));
  md = upsertSection(
    md,
    "Never say",
    [draft.neverSay.length ? bullets(draft.neverSay) : "", draft.bannedPhrases.length ? `Hard bans (also in brand.yaml): ${draft.bannedPhrases.map((p) => `"${p}"`).join(", ")}` : ""]
      .filter(Boolean)
      .join("\n\n") || TODO("words and tones that are not you"),
  );
  md = upsertSection(md, "Examples", draft.examples.length ? draft.examples.map((e) => `> ${e.trim().replace(/\n+/g, " ")}`).join("\n\n") : TODO("3 to 5 short passages from your own transcripts"));
  return `${md.trimEnd()}\n`;
}

const COMPETITOR_HEADER = [
  "# Creators the Analyst watches for outliers: posts that did far better than that creator's usual.",
  "# AttentionOS studies the structure of what works (hooks, formats, angles), never copies the words.",
  "#",
  "# platform: instagram, tiktok, youtube, facebook, linkedin, x, threads",
  "# tier: core | adjacent | aspirational | remake",
  "",
].join("\n");

export function normalizeHandle(handle: string): string {
  const h = handle.trim().replace(/^https?:\/\/(www\.)?[^/]+\/(@)?/i, "").replace(/[/?#].*$/, "");
  return h.startsWith("@") ? h : `@${h}`;
}

export function competitorsYaml(creators: Competitor[]): string {
  const seen = new Set<string>();
  const clean = creators
    .map((c) => ({ handle: normalizeHandle(c.handle), platform: c.platform, tier: c.tier, ...(c.notes?.trim() ? { notes: c.notes.trim() } : {}) }))
    .filter((c) => {
      const k = `${c.platform}:${c.handle.toLowerCase()}`;
      if (seen.has(k) || c.handle.length < 2) return false;
      seen.add(k);
      return true;
    });
  return `${COMPETITOR_HEADER}${stringify({ creators: clean }, { lineWidth: 0 })}`;
}

const SOURCES_HEADER = [
  "# News and trend sources for your niche. The trend radar checks these and scores what's heating up.",
  "# kind options: google_news (search query), rss (feed URL), reddit (subreddit), hn (search), github (topic), x_apify",
  "# weight raises or lowers how much a source counts (1 is normal). enabled: false pauses a source.",
  "",
].join("\n");

export function sourcesYaml(sources: TrendSourceConfig[]): string {
  const ids = new Set<string>();
  const clean = sources.map((s) => {
    let id = slugify(s.id || `${s.kind}-${s.target}`, 40);
    for (let n = 2; ids.has(id); n++) id = `${slugify(s.id || `${s.kind}-${s.target}`, 36)}-${n}`;
    ids.add(id);
    return { id, kind: s.kind, target: s.target.trim(), weight: s.weight, enabled: s.enabled };
  });
  return `${SOURCES_HEADER}${stringify({ sources: clean }, { lineWidth: 0 })}`;
}

export type HouseStyleChoice = {
  captions: "clean" | "bold" | "minimal";
  pacing: "tight" | "natural";
  music: boolean;
  sfx: boolean;
};

const CAPTION_RULES: Record<HouseStyleChoice["captions"], string> = {
  clean: "Clean captions: two lines at most, one emphasised word per line, no emojis.",
  bold: "Bold captions: large words in short bursts, one strong emphasis colour, no emojis.",
  minimal: "Minimal captions: small, lower third, no emphasis. Let the face carry the video.",
};

/** house-style.md with the wizard's choices; the rest of the owner's notes stay. */
export function houseStyleMd(current: string, choice: HouseStyleChoice, formats: { id: string; name: string }[]): string {
  let md = current.trim() ? current : "# House style for edits\n";
  md = upsertSection(
    md,
    "Pacing",
    choice.pacing === "tight"
      ? bullets(["No pause longer than 0.15 seconds unless it is there on purpose.", "The hook (first 3 seconds) is never cut into.", "When you repeat a line, the last full take wins."])
      : bullets(["Keep natural breathing room: cut dead air and flubs, not every pause.", "The hook (first 3 seconds) is never cut into.", "When you repeat a line, the last full take wins."]),
  );
  md = upsertSection(md, "Captions", CAPTION_RULES[choice.captions]);
  md = upsertSection(
    md,
    "Sound",
    bullets([
      "Loudness is normalised to −14 LUFS so every post sounds the same volume.",
      choice.music ? "A quiet music bed is fine under talking videos; trending sounds are added in the app." : "No music bed in the edit; add a trending sound in the app if you want one.",
      choice.sfx ? "Light sound effects on cuts and pop-ups are welcome." : "No sound effects.",
    ]),
  );
  if (formats.length) md = upsertSection(md, "Formats we use", bullets(formats.map((f) => `\`${f.id}\`: ${f.name}`)));
  return `${md.trimEnd()}\n`;
}

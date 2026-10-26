import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type WorkspaceContext } from "@attentionos/core";
import { suggestKeywords } from "@attentionos/guardrails";
import { getContent, getContentKeyword, ledgerWords, recentScripts } from "./db.ts";
import { findRemixSources, loadRemixSource, remixSourceId } from "./remix.ts";
import { getClaimSources, getContentBrief, pickHooks } from "./service.ts";
import { scriptingSettings } from "./settings.ts";

/**
 * The write-script "work packet": everything the Copywriter needs, gathered in code before the run starts, so the
 * agent drafts in one go instead of spending a turn per file or lookup. It holds the brief (with the remix source's
 * checked blueprint and the owner's best posts), the claim sources, free keywords, recent scripts, hook picks for
 * originals, the Brand Kit text the skill says to read, and the method checklists. No untrusted text: the remix
 * source is its validated blueprint, never its transcript.
 */

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const METHOD_SKILLS = ["hook-audit", "spoken-humanizer", "claim-ledger", "captions"] as const;

/** A skill's body without its front matter (engine text, not brand text). */
export function skillBody(name: string): string {
  try {
    return readFileSync(`${SKILLS_DIR}/${name}/SKILL.md`, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  } catch {
    return "";
  }
}

/** Brand Kit text the write-script skill reads first, from the workspace (never from engine code). */
function brandText(ws: WorkspaceContext): Record<string, string> {
  const docs = ws.brand().docs;
  const out: Record<string, string> = {};
  for (const key of ["voice", "lessons", "icp", "offers"] as const) {
    const t = docs[key]?.trim();
    if (t) out[`brand/${key}.md`] = t.length > 6000 ? `${t.slice(0, 6000)}\n[...trimmed]` : t;
  }
  return out;
}

/** The caption CTA checks, stated up front so the first draft passes them (guardrails `validateCaptions`). */
const CAPTION_CTA_RULES = {
  commentOrDmKeyword: "Instagram: the keyword in capitals (\"Comment WORD and I'll send it\"). TikTok and YouTube: \"DM me WORD\" or \"link in bio\", never \"comment\". Facebook, LinkedIn and X: a link line (\"link in bio\"), never \"comment WORD\".",
  linkInBio: "Instagram and TikTok say \"link in bio\".",
  links: "No links in Instagram captions or the LinkedIn body; say \"link in bio\".",
};

/** What a comment keyword usually promises: used when the topic's own words will be said in the script. */
const DELIVERABLE_WORDS = ["setup", "playbook", "template", "toolkit", "workflow", "checklist", "blueprint", "roadmap", "stack", "steps"];

/**
 * Three free keywords: topic words first, then deliverable words, none the script is likely to say. The deliverable
 * words start at a different place per piece (`seed`, the content id), so scripts written at the same time don't
 * all reach for the same free word.
 */
export function freeKeywords(topicText: string, ledger: readonly string[], willSay = "", seed = ""): string[] {
  const fromTopic = suggestKeywords({ topicText, ledgerWords: ledger, scriptText: willSay, count: 3 });
  if (fromTopic.length >= 3) return fromTopic.map((k) => k.toUpperCase());
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const start = h % DELIVERABLE_WORDS.length;
  const rotated = [...DELIVERABLE_WORDS.slice(start), ...DELIVERABLE_WORDS.slice(0, start)];
  const extra = suggestKeywords({ topicText: "", candidates: rotated, ledgerWords: [...ledger, ...fromTopic], scriptText: willSay, count: 3 - fromTopic.length });
  return [...fromTopic, ...extra].map((k) => k.toUpperCase());
}

export async function writePacket(ws: WorkspaceContext, contentId: string) {
  const settings = scriptingSettings(ws);
  const content = await getContent(ws, contentId);
  if (!content) throw new Error(`No content item with id ${contentId}.`);
  const sourceId = remixSourceId(content);
  const remix = Boolean(sourceId);
  // A remix's keyword comes from what it's about (the blueprint topic), never from a placeholder title, and never from
  // a word its script will say anyway (the source's hook and beats): that would trip the "keyword in script" check.
  const bp = sourceId ? (await loadRemixSource(ws, sourceId))?.blueprint : null;
  const topic = bp?.topic ?? content.title.replace(/^remix:\s*/i, "");
  const willSay = bp ? [bp.topic, bp.hookLine, ...bp.beats.map((b) => b.says)].join(" ") : "";
  const [brief, sources, reserved, recent] = await Promise.all([
    getContentBrief(ws, contentId),
    getClaimSources(ws, contentId, settings),
    getContentKeyword(ws, contentId),
    recentScripts(ws, { limit: 8, excludeContentId: contentId }),
  ]);
  const ledger = reserved ? [] : await ledgerWords(ws, contentId);
  const notes = typeof content.brief?.notes === "string" ? content.brief.notes : "";
  return {
    brief,
    claimSources: {
      proof: sources.proofDetail.map((p) => ({ ref: `proof:${p.id}`, ...p })),
      cited: sources.cited.map((c) => ({ ref: `cited:${c.id}`, ...c })),
      /** The owner's own offers, site and (for a remake of their own post) that post: theirs to state, no "they say" needed. */
      own: (sources.own ?? []).map(({ wholeSite: _w, ...o }) => ({ ref: o.id === "site" || o.id === "own-post" ? `own:${o.id}` : `offer:${o.id}`, ...o })),
      spentStats: sources.recentStats?.slice(0, 20) ?? [],
    },
    keyword: reserved
      ? { reserved: reserved.word.toUpperCase() }
      : { freeToUse: freeKeywords(`${topic} ${content.angle ?? ""} ${notes}`, ledger, willSay, content.id) },
    recentScripts: recent.map((r) => ({ title: r.title, hook: r.hook_text, pattern: (r.hook_source?.pattern as string | undefined) ?? null })),
    // Originals only: bank hooks, and proven posts that match the ask (facts and checked blueprint fields only).
    ...(remix
      ? {}
      : {
          hookPicks: (await pickHooks(ws, { count: 3 })).picks.map((p) => ({ ...p.view, reason: p.reason })),
          provenPostsOnThisTopic: await findRemixSources(ws, { topic: `${content.title} ${notes}`.slice(0, 200), limit: 3 }),
        }),
    brandKit: brandText(ws),
    // The caption rules the save checks, so the first draft passes them.
    captionRules: {
      platforms: brief.rules.platforms,
      hashtagPool: ws.brand().brand.hashtagPool,
      hashtagsPerPlatform: "3 to 5 (X: 0 to 3), prefer the pool; in the hashtags list only, never inside the text",
      ctaPerPlatform: CAPTION_CTA_RULES,
    },
    // A remix keeps its source's hook, so the hook audit is for originals only.
    method: Object.fromEntries(METHOD_SKILLS.filter((s) => !(remix && s === "hook-audit")).map((s) => [s, skillBody(s)]).filter(([, t]) => t)),
  };
}
export type WritePacket = Awaited<ReturnType<typeof writePacket>>;

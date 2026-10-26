import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrandKit } from "@attentionos/core";
import { DEMO_BRAND_DIR } from "@attentionos/module-research/testing";
import { appendRejectedConcept, inferLaneKinds, loadPresetDefaults, parsePillars } from "../src/pillars.ts";
import { planSlate, type PlannerInput } from "../src/planner.ts";

const TEMPLATE_PILLARS = resolve(import.meta.dirname, "../../../templates/workspace/brand/pillars.md");

describe("pillars.md", () => {
  it("reads lanes from front matter and angles, structures and rejected concepts from sections", () => {
    const p = parsePillars(readFileSync(join(DEMO_BRAND_DIR, "pillars.md"), "utf8"));
    expect(p.problems).toEqual([]);
    expect(p.fallbackLanes).toBe(false);
    expect(p.lanes.map((l) => [l.id, l.kinds])).toEqual([
      ["job-site-proof", ["talking_head", "remix"]],
      ["customer-question", ["talking_head", "remix"]],
      ["myth-bust", ["talking_head", "remix"]],
      ["local-news-take", ["news"]],
      ["offer", ["offer"]],
    ]);
    expect(p.lanes[0]!.proofKinds).toEqual(expect.arrayContaining(["case_study", "client_win"]));
    expect(p.lanes[1]!.proofKinds).toContain("faq");
    expect(p.mainAngle).toBe("Plan the renovation before you hire anyone, and the build stops surprising you.");
    expect(p.angles).toHaveLength(3);
    expect(p.storyStructures).toHaveLength(7);
    expect(p.storyStructures[1]).toEqual({ id: "the-mistake", name: "The mistake", description: "a costly mistake, what it cost, the fix." });
    expect(p.rejected).toEqual([{ date: "2026-09-30", text: "Dancing contractor trend", why: "off-brand" }]);
  });

  it("reads the workspace template as shipped (TODO placeholders are not angles)", () => {
    const p = parsePillars(readFileSync(TEMPLATE_PILLARS, "utf8"));
    expect(p.lanes.length).toBeGreaterThanOrEqual(3);
    expect(p.mainAngle).toBeNull();
    expect(p.angles).toEqual([]);
    expect(p.storyStructures).toHaveLength(7);
    expect(p.rejected).toEqual([]);
  });

  it("falls back to generic lanes and reports bad front matter", () => {
    expect(parsePillars("# no front matter").fallbackLanes).toBe(true);
    const bad = parsePillars("---\nlanes:\n  - id: x\n    name: X\n    weeklyQuota: -1\n    funnelStage: tofu\n---\n");
    expect(bad.problems[0]).toContain("brand/pillars.md front matter");
    expect(inferLaneKinds({ id: "promo", name: "Book a call", funnelStage: "bofu" }).kinds).toEqual(["offer"]);
  });

  it("appends rejected concepts without disturbing other sections", () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-pillars-"));
    cpSync(DEMO_BRAND_DIR, dir, { recursive: true });
    appendRejectedConcept(dir, { date: "2026-10-11", text: "Price war · teaser", why: "we don't compete on price" });
    const md = readFileSync(join(dir, "pillars.md"), "utf8");
    expect(md).toContain("- 2026-10-11 · Price war - teaser · we don't compete on price");
    expect(parsePillars(md).rejected).toHaveLength(2);
    expect(parsePillars(md).lanes).toHaveLength(5);
    writeFileSync(join(dir, "pillars.md"), "---\nlanes: []\n---\n# Pillars\n\n## Main angle\n\nX\n");
    appendRejectedConcept(dir, { date: "2026-10-11", text: "Idea" });
    expect(readFileSync(join(dir, "pillars.md"), "utf8")).toMatch(/## Main angle\n\nX\n\n## Rejected concepts\n\n- 2026-10-11 · Idea\n$/);
  });

  it("reads preset cadence, CTA and formats from brand/knowledge", () => {
    const kit = loadBrandKit(DEMO_BRAND_DIR);
    const d = loadPresetDefaults(DEMO_BRAND_DIR, kit.docs);
    expect(d.weeklyShortVideos).toBe(8);
    expect(d.ctaByStage).toEqual({ tofu: "follow", mofu: "comment_keyword", bofu: "book_call" });
    expect(Object.keys(d.formats)).toEqual(["raw-talking-head", "popup-presenter", "split-demo", "news-greenscreen"]);
    expect(d.formats["news-greenscreen"]!.shootDirections).toContain("Plain background");
    expect(loadPresetDefaults("/nonexistent", {})).toEqual({ weeklyShortVideos: null, ctaByStage: {}, formats: {} });
  });
});

const NOW = new Date("2026-10-12T10:00:00Z");
const pillars = parsePillars(readFileSync(join(DEMO_BRAND_DIR, "pillars.md"), "utf8"));
const kit = loadBrandKit(DEMO_BRAND_DIR);

function baseInput(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    mode: "daily",
    now: NOW,
    seed: "ws-1:2026-10-12:daily",
    slots: { news: 2, remix: 2, talking_head: 2, offer: 1 },
    lanes: pillars.lanes,
    laneCountsThisWeek: {},
    funnelTarget: { tofu: 50, mofu: 30, bofu: 20 },
    recentFunnel: [],
    mainAngle: pillars.mainAngle,
    angles: pillars.angles,
    storyStructures: pillars.storyStructures,
    recent: [],
    rejected: pillars.rejected.map((r) => r.text),
    trends: [
      { id: "t1", url: "https://news.example.org/a", heat: 80, header: "Permits just went online", hasKit: true },
      { id: "t2", url: "https://news.example.org/b", heat: 95, header: null, hasKit: false },
      { id: "t3", url: "https://news.example.org/c", heat: 60, header: "Lumber prices ease again", hasKit: true },
    ],
    outliers: [
      { id: "o1", url: "https://www.instagram.com/reel/a/", creator: "@demo_creator_a", platform: "instagram", x: 4.4, hookPattern: "question" },
      { id: "o2", url: "https://www.instagram.com/reel/b/", creator: "@demo_creator_c", platform: "instagram", x: 3.1 },
      { id: "o3", url: "https://www.instagram.com/reel/c/", creator: "@demo_creator_c", platform: "instagram", x: 2.2 },
    ],
    proof: kit.proofInventory.items.map((p) => ({ id: p.id, kind: p.kind, title: p.title, summary: p.summary, numbers: p.numbers, clientConsent: p.clientConsent, lastUsedAt: null })),
    offers: kit.brand.offers.map((o) => ({ id: o.id, name: o.name, cta: o.cta })),
    templates: {},
    ctaByStage: { tofu: "follow", mofu: "comment_keyword", bofu: "book_call" },
    weights: {},
    explore: 0.2,
    cooldowns: { topicDays: 14, proofDays: 21, angleDays: 3 },
    filmBy: { newsHours: 24, defaultHours: 72 },
    storyShare: 1 / 3,
    ...over,
  };
}

describe("planner", () => {
  it("is deterministic for the same inputs and seed", () => {
    expect(planSlate(baseInput())).toEqual(planSlate(baseInput()));
  });

  it("fills the slate in order: news with kits, outlier remixes, talking heads, offer", () => {
    const { items, notes } = planSlate(baseInput());
    expect(items.map((i) => i.kind)).toEqual(["news", "news", "remix", "remix", "talking_head", "talking_head", "offer"]);
    expect(items[0]).toMatchObject({ title: "Permits just went online", lane: "local-news-take", template: "news-greenscreen", ctaType: "follow", angle: null, storyStructure: null });
    expect(items[0]!.filmBy).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
    // the hottest trend has no validated kit, so it is never used (its title is untrusted)
    expect(items.some((i) => i.sourceRefs.some((r) => r.id === "t2"))).toBe(false);
    expect(items[2]!.sourceRefs[0]).toEqual({ type: "external_post", id: "o1", url: "https://www.instagram.com/reel/a/" });
    // A remix keeps the source's structure (no angle or story structure of its own) and says where it came from.
    expect(items[2]).toMatchObject({ angle: null, storyStructure: null, title: "Remix: @demo_creator_a's instagram post", remixOf: { externalPostId: "o1", line: "Based on @demo_creator_a's reel, 4.4x their normal" } });
    expect(items[6]).toMatchObject({ kind: "offer", lane: "offer", ctaType: "book_call", funnelStage: "bofu", title: "Offer: Renovation plan session" });
    expect(items.map((i) => i.slot)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(notes).toEqual([]);
  });

  it("only uses numbers from the proof inventory and rotates proof with a cooldown", () => {
    const { items } = planSlate(baseInput());
    const proofs = items.filter((i) => i.proof);
    expect(new Set(proofs.map((p) => p.proof!.id)).size).toBe(proofs.length);
    for (const p of proofs) expect(p.proof!.numbers).toEqual(kit.proofInventory.items.find((x) => x.id === p.proof!.id)!.numbers);
    const allUsed = baseInput().proof.map((p) => ({ ...p, lastUsedAt: new Date(NOW.getTime() - 86_400_000).toISOString() }));
    expect(planSlate(baseInput({ proof: allUsed })).items.filter((i) => i.proof).length).toBe(0);
  });

  it("skips outliers and trends already used, topics in cooldown and rejected concepts", () => {
    const recent = [{ title: "Permits just went online", lane: "local-news-take", funnelStage: "tofu" as const, angle: null, template: "news-greenscreen", storyStructure: null, createdAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), sourceIds: ["o1"] }];
    const { items } = planSlate(baseInput({ recent, rejected: ["Lumber prices ease"] }));
    expect(items.filter((i) => i.kind === "news")).toHaveLength(0);
    expect(items.some((i) => i.sourceRefs.some((r) => r.id === "o1"))).toBe(false);
    // open news slots are backfilled (proven posts first, then talking heads) so the slate keeps its size, or the
    // shortfall is reported
    const { notes } = planSlate(baseInput({ recent, rejected: ["Lumber prices ease"] }));
    const unfilled = notes.find((n) => n.includes("couldn't be backfilled"));
    expect(items.length + (unfilled ? Number(/^(\d+)/.exec(unfilled)![1]) : 0)).toBe(7);
  });

  it("leans toward the funnel stage that is behind and lanes with quota left", () => {
    const tofuHeavy = planSlate(baseInput({ slots: { news: 0, remix: 0, talking_head: 6, offer: 0 }, recentFunnel: Array(20).fill("tofu") }));
    const mofu = tofuHeavy.items.filter((i) => i.funnelStage === "mofu").length;
    expect(mofu).toBeGreaterThanOrEqual(2);
    // With exploration off, the only lane with quota left wins; once every quota is met, any lane may be picked.
    const full = planSlate(baseInput({ slots: { news: 0, remix: 0, talking_head: 3, offer: 0 }, laneCountsThisWeek: { "job-site-proof": 2, "customer-question": 2 }, explore: 0 }));
    expect(full.items[0]!.lane).toBe("myth-bust");
    expect(full.items).toHaveLength(3);
  });

  it("rotates templates and uses a story structure on roughly one idea in three", () => {
    const { items } = planSlate(baseInput({ slots: { news: 0, remix: 3, talking_head: 0, offer: 0 } }));
    expect(new Set(items.map((i) => i.template)).size).toBe(3);
    let withStory = 0;
    let total = 0;
    for (let d = 1; d <= 30; d++) {
      const r = planSlate(baseInput({ seed: `ws-1:day-${d}` }));
      total += r.items.filter((i) => i.kind !== "news").length;
      withStory += r.items.filter((i) => i.storyStructure).length;
    }
    expect(withStory / total).toBeGreaterThan(0.2);
    expect(withStory / total).toBeLessThan(0.5);
  });

  it("reports open slots it couldn't fill", () => {
    const { notes, items } = planSlate(baseInput({ trends: [], outliers: [], slots: { news: 1, remix: 1, talking_head: 0, offer: 0 } }));
    expect(notes).toEqual(["1 news slot left open: no fresh story on the trend desk", "1 remix slot left open: no new outliers to remix"]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "talking_head")).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { competitorsSchema, proofInventorySchema, sourcesSchema } from "@attentionos/core";
import { parse as parseYaml } from "yaml";
import { validateBrandFile } from "../src/lib/brand-files.ts";
import {
  brandYamlFromBusiness,
  competitorsYaml,
  houseStyleMd,
  icpMd,
  icpMdWithAnswers,
  offersMd,
  proofInventoryWithAnswers,
  proofInventoryYaml,
  sourcesYaml,
  voiceMd,
} from "../src/lib/render.ts";
import {
  competitorSuggestionsOutput,
  interviewTurnOutput,
  jsonShape,
  parseModelJson,
  readModelOutput,
  sanitizeBusiness,
  sanitizeSuggestions,
  sanitizeVoice,
  siteAnalysisOutput,
  verbatimExamples,
  voiceProfileOutput,
} from "../src/schemas.ts";
import { htmlToText, isPublicHttpUrl, normalizeSiteUrl, offerLinks, readSite } from "../src/lib/web.ts";

const TEMPLATE = join(import.meta.dirname, "..", "..", "..", "templates", "workspace", "brand");
const tpl = (f: string) => readFileSync(join(TEMPLATE, f), "utf8").replace("{{WORKSPACE_NAME}}", "My brand").replace("{{TIMEZONE}}", "America/New_York");

/** A recorded model answer for the fictional demo brand. */
const SITE_FIXTURE = {
  name: "Examplebrand Studio",
  oneLiner: "We help small firms turn their expertise into short videos that bring in booked calls.",
  offers: [
    { name: "Content sprint", url: "https://examplebrand.example/sprint", cta: "book_call", whoFor: "Owner-led service firms", whatTheyGet: "A month of filmed short videos", price: "", howToStart: "Book a call" },
    { name: "Content sprint", url: "not a url", cta: "book_call", whoFor: "", whatTheyGet: "", price: "", howToStart: "" },
    { name: "  ", cta: "link_in_bio", whoFor: "", whatTheyGet: "", price: "", howToStart: "" },
  ],
  claimableResults: ["Most sprints finish on schedule", "Most sprints finish on schedule"],
  neverPromise: ["Guaranteed follower growth"],
  audience: { who: "Founders of small service firms", wants: "Clients who already trust them", stuck: "No time to film", quotes: ["I never know what to post."], objections: ["Video feels awkward"], notFor: "" },
  summary: ["Short-video studio for small firms", "Sells a monthly sprint", "People book a call"],
  openQuestions: ["What does the sprint cost?"],
};

const POSTS = [
  { text: "Here's the thing nobody tells you about pricing. You don't need a bigger audience. You need a clearer offer." },
  { text: "Three questions I ask every new client before we film anything. One: who is this for? Two: what do they say when they're stuck?" },
  { text: "Stop posting tips. Start posting decisions. Your buyers want to watch you think, not recite a list." },
];

describe("job output schemas", () => {
  it("convert to JSON Schema for the model", () => {
    for (const s of [siteAnalysisOutput, voiceProfileOutput, interviewTurnOutput, competitorSuggestionsOutput]) {
      const json = z.toJSONSchema(s) as { type?: string; properties?: object };
      expect(json.type).toBe("object");
      expect(json.properties).toBeTruthy();
    }
  });

  it("accept the recorded site analysis and reject a broken one", () => {
    expect(siteAnalysisOutput.safeParse(SITE_FIXTURE).success).toBe(true);
    expect(siteAnalysisOutput.safeParse({ ...SITE_FIXTURE, offers: [{ name: "x", cta: "phone_us" }] }).success).toBe(false);
    expect(interviewTurnOutput.safeParse({ reply: "What do they say?", done: false }).success).toBe(true);
    expect(interviewTurnOutput.safeParse({ reply: "x" }).success).toBe(false);
  });
});

describe("reading the model's answer", () => {
  it("states the shape in the prompt without the draft 2020-12 $schema Claude Code rejects", () => {
    const shape = jsonShape(interviewTurnOutput);
    expect(shape).not.toContain("$schema");
    expect(shape).toContain('"reply"');
  });

  it("accepts plain, fenced or wrapped JSON and validates it", () => {
    const ok = { reply: "What do they say?", done: false };
    expect(readModelOutput(interviewTurnOutput, ok)).toEqual(ok);
    expect(readModelOutput(interviewTurnOutput, { summary: JSON.stringify(ok) })).toEqual(ok);
    expect(readModelOutput(interviewTurnOutput, { summary: "Here you go:\n```json\n" + JSON.stringify(ok) + "\n```" })).toEqual(ok);
    expect(readModelOutput(interviewTurnOutput, { summary: `Noted. ${JSON.stringify(ok)} Done.` })).toEqual(ok);
    expect(parseModelJson("no json here")).toBeUndefined();
    expect(() => readModelOutput(interviewTurnOutput, { summary: "no json" })).toThrow(/valid JSON/);
    expect(() => readModelOutput(interviewTurnOutput, { summary: '{"reply": 3}' })).toThrow(/expected format/);
  });
});

describe("sanitizers", () => {
  it("cleans the business draft: unique slugs, real links only, no empty offers, no duplicates", () => {
    const d = sanitizeBusiness(siteAnalysisOutput.parse(SITE_FIXTURE), "https://examplebrand.example/");
    expect(d.offers.map((o) => o.id)).toEqual(["content-sprint", "content-sprint-2"]);
    expect(d.offers[0]!.url).toBe("https://examplebrand.example/sprint");
    expect(d.offers[1]!.url).toBeUndefined();
    expect(d.claimableResults).toEqual(["Most sprints finish on schedule"]);
    expect(d.website).toBe("https://examplebrand.example/");
  });

  it("keeps only voice examples that appear word for word in the owner's posts", () => {
    const kept = verbatimExamples(["You don't need a bigger audience. You need a clearer offer.", "You need a bigger audience and more hashtags."], POSTS);
    expect(kept).toEqual(["You don't need a bigger audience. You need a clearer offer."]);
    const v = sanitizeVoice(
      voiceProfileOutput.parse({
        oneLine: "Direct, calm, a little contrarian.",
        howWeTalk: ["Short sentences", "Short sentences", "Opens with a claim"],
        signatureMoves: ["Counts points out loud"],
        neverSay: ["Hype"],
        bannedPhrases: ["game changer", "x", "unlock your potential"],
        examples: ["Stop posting tips. Start posting decisions.", "Invented line that was never said"],
        summary: "Scripts will open with a decision.",
      }),
      POSTS,
    );
    expect(v.howWeTalk).toEqual(["Short sentences", "Opens with a claim"]);
    expect(v.bannedPhrases).toEqual(["game changer", "unlock your potential"]);
    expect(v.examples).toEqual(["Stop posting tips. Start posting decisions."]);
    expect(v.basedOnPosts).toBe(3);
  });

  it("drops own handles, bad handles, duplicates and non-URL feeds from suggestions", () => {
    const s = sanitizeSuggestions(
      competitorSuggestionsOutput.parse({
        competitors: [
          { handle: "@peer_one", platform: "instagram", tier: "core", why: "Same audience" },
          { handle: "peer_one", platform: "instagram", tier: "core", why: "dupe" },
          { handle: "https://www.tiktok.com/@peer_two?lang=en", platform: "tiktok", tier: "adjacent", why: "" },
          { handle: "@examplebrand", platform: "instagram", tier: "core", why: "own" },
          { handle: "not a handle!", platform: "youtube", tier: "core", why: "" },
        ],
        sources: [
          { kind: "reddit", target: "r/smallbusiness", why: "" },
          { kind: "rss", target: "industry news", why: "" },
          { kind: "google_news", target: "creator economy report", why: "" },
        ],
      }),
      ["@examplebrand"],
    );
    expect(s.competitors.map((c) => `${c.platform}:${c.handle}`)).toEqual(["instagram:@peer_one", "tiktok:@peer_two"]);
    expect(s.sources.map((x) => x.target)).toEqual(["smallbusiness", "creator economy report"]);
  });
});

describe("renderers produce valid Brand Kit files", () => {
  const draft = sanitizeBusiness(siteAnalysisOutput.parse(SITE_FIXTURE), "https://examplebrand.example/");

  it("brand.yaml keeps its comments and validates", () => {
    const out = brandYamlFromBusiness(tpl("brand.yaml"), draft);
    expect(out).toContain("# The basics about your brand.");
    expect(() => validateBrandFile("brand.yaml", out)).not.toThrow();
    const parsed = parseYaml(out) as { name: string; offers: { id: string; url?: string }[]; cta: { siteUrl: string } };
    expect(parsed.name).toBe("Examplebrand Studio");
    expect(parsed.offers).toHaveLength(2);
    expect(parsed.offers[1]!.url).toBeUndefined();
    expect(parsed.cta.siteUrl).toBe("https://examplebrand.example/");
  });

  it("offers.md and icp.md fill the starter sections", () => {
    const offers = offersMd(tpl("offers.md"), draft);
    expect(offers).toContain("### Content sprint");
    expect(offers).toContain("- Most sprints finish on schedule");
    const icp = icpMd(tpl("icp.md"), draft);
    expect(icp).toContain('- "I never know what to post."');
    expect(icp).toContain("## Who it's not for\n\n<!-- TODO");
    const more = icpMdWithAnswers(icp, [
      { kind: "quote", text: "I never know what to post.", numbers: [], clientConsent: false, at: "x" },
      { kind: "pain", text: "Filming takes a whole day", numbers: [], clientConsent: false, at: "x" },
    ]);
    expect(more.match(/I never know what to post/g)).toHaveLength(1);
    expect(more).toContain("- Filming takes a whole day");
  });

  it("proof items from the interview keep sources and validate", () => {
    const items = proofInventoryWithAnswers(
      [],
      [
        { kind: "proof", text: "A firm doubled its booked calls in a quarter. They post twice a week now.", numbers: [{ value: "2x", label: "booked calls", source: "owner, onboarding interview 2026-10-12" }], clientConsent: false, at: "x" },
        { kind: "pain", text: "Not proof", numbers: [], clientConsent: false, at: "x" },
        { kind: "faq", text: "How long does a sprint take? About a month.", numbers: [], clientConsent: false, at: "x" },
      ],
      "2026-10-12",
    );
    expect(items.map((i) => i.kind)).toEqual(["client_win", "faq"]);
    const yaml = proofInventoryYaml(items);
    expect(() => validateBrandFile("proof-inventory.yaml", yaml)).not.toThrow();
    expect(proofInventorySchema.parse(parseYaml(yaml)).items[0]!.numbers[0]!.source).toContain("onboarding interview");
  });

  it("voice.md, competitors.yaml, sources.yaml and house-style.md", () => {
    const voice = voiceMd(tpl("voice.md"), sanitizeVoice(voiceProfileOutput.parse({ oneLine: "Calm", howWeTalk: ["Short"], signatureMoves: [], neverSay: [], bannedPhrases: ["game changer"], examples: [POSTS[2]!.text], summary: "" }), POSTS));
    expect(voice).toContain("## In one line\n\nCalm");
    expect(voice).toContain('Hard bans (also in brand.yaml): "game changer"');
    const comp = competitorsYaml([{ handle: "peer_one", platform: "instagram", tier: "core" }, { handle: "@Peer_One", platform: "instagram", tier: "core" }]);
    expect(competitorsSchema.parse(parseYaml(comp)).creators).toHaveLength(1);
    const src = sourcesYaml([{ id: "", kind: "reddit", target: "smallbusiness", weight: 1, enabled: true }, { id: "", kind: "reddit", target: "smallbusiness", weight: 1, enabled: false }]);
    const ids = sourcesSchema.parse(parseYaml(src)).sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(() => validateBrandFile("sources.yaml", src)).not.toThrow();
    const hs = houseStyleMd(readFileSync(join(TEMPLATE, "house-style.md"), "utf8"), { captions: "clean", pacing: "natural", music: false, sfx: true }, [{ id: "raw-talking-head", name: "Raw talking head" }]);
    expect(hs).toContain("Clean captions");
    expect(hs).toContain("Light sound effects");
    expect(hs).toContain("## Formats we use");
    expect(hs).toContain("## Look");
  });
});

describe("site reader", () => {
  const HOME = `<!doctype html><html><head><title>Examplebrand Studio &amp; co</title><meta name="description" content="Short videos for small firms"><script>evil()</script><style>.x{}</style></head>
  <body><h1>Short videos that book calls</h1><p>We film &ldquo;one decision&rdquo; at a time.</p><ul><li>Content sprint</li></ul>
  <a href="/about">About</a><a href="/services/sprint">Sprint</a><a href="https://other.example/pricing">Other</a><a href="/blog/post">Blog</a></body></html>`;

  it("turns HTML into readable text", () => {
    const t = htmlToText(HOME);
    expect(t.title).toBe("Examplebrand Studio & co");
    expect(t.description).toBe("Short videos for small firms");
    expect(t.text).toContain("# Short videos that book calls");
    expect(t.text).toContain("“one decision”");
    expect(t.text).toContain("- Content sprint");
    expect(t.text).not.toContain("evil");
  });

  it("follows only same-site offer links", () => {
    expect(offerLinks(HOME, new URL("https://examplebrand.example/"))).toEqual(["https://examplebrand.example/about", "https://examplebrand.example/services/sprint"]);
  });

  it("refuses local and private addresses", () => {
    expect(normalizeSiteUrl("examplebrand.example")).toBe("https://examplebrand.example/");
    for (const bad of ["http://localhost:3000", "http://127.0.0.1", "http://10.0.0.2", "http://192.168.1.1", "file:///etc/passwd", "http://intranet"]) expect(isPublicHttpUrl(bad)).toBe(false);
  });

  it("reads the home page and its offer pages with an injected fetch", async () => {
    const seen: string[] = [];
    const fake = (async (url: string | URL) => {
      seen.push(String(url));
      const body = String(url).endsWith("/about") ? "<h1>About us</h1>" : String(url).includes("sprint") ? "<h1>Sprint</h1>" : HOME;
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const site = await readSite(["https://examplebrand.example"], { fetch: fake });
    expect(site.pages.map((p) => new URL(p.url).pathname)).toEqual(["/", "/about", "/services/sprint"]);
    expect(seen).toHaveLength(3);
    expect(site.problems).toEqual([]);
  });
});

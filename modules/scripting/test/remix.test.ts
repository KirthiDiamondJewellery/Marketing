import { basedOnLine, formatViews, type Sql, type WorkspaceContext } from "@attentionos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyHooksJob, findRemixSources, getClaimSources, getContentBrief, provenScore, REMIX_RULES, remixRulesFor, remixView, runWriteScript,
  startWaitingScript, topicMatch, useRemixSource, validateForContent, writeScriptAgentPrompt, writeScriptPrompt, type RemixSource, type ScriptModel,
} from "../src/index.ts";
import { getContent } from "../src/db.ts";
import { scriptingTools } from "../src/tools/index.ts";
import { validCaptions } from "../../../packages/guardrails/test/fixtures.ts";
import { hasTestDatabase, makeContent, makeHook, makeWorkspace, NEEDS_DB, NOW, testDb } from "./helpers.ts";

/** Fictional demo creator, transcript and blueprint. */
const TRANSCRIPT =
  "The cheapest cabinet quote we got was missing three things. First, the install labour was never in the price. " +
  "Second, the crown moulding was an extra 900 dollars. Third, nobody priced hauling the old boxes away. " +
  "I'm Rowan from Maple and Oak and we fixed it for 14000 dollars. Comment QUOTE and I'll send you the checklist.";
const BLUEPRINT = {
  topic: "What a cheap quote leaves out",
  hookLine: "The cheapest cabinet quote we got was missing three things.",
  hookPattern: "hidden cost",
  hookMechanic: "Names a cost the viewer is about to pay.",
  beats: [
    { role: "hook", at: "0-3s", does: "States the surprise", says: "The cheapest [item] quote was missing [three things]" },
    { role: "proof", at: "3-8s", does: "Shows it happened", says: "A [result] with a [number]" },
    { role: "play", at: "8-18s", does: "Lists the missing items", says: "First [cost], second [cost], third [cost]" },
    { role: "close", at: "18-24s", does: "Offers the checklist", says: "Comment [keyword] for the checklist" },
  ],
  format: "talking_head",
  visual: "Face close-up, text for each item",
  ctaMechanic: "Comment a keyword to get a checklist",
  ctaType: "comment_keyword",
  whyItWorked: ["Money at stake in the first line"],
  swapOut: ["@demo_creator_a", "Rowan", "Maple and Oak"],
  words: 60,
  durationS: 24,
  wordsPerSecond: 2.5,
};

const source = (over: Partial<RemixSource> = {}): RemixSource => ({
  externalPostId: "00000000-0000-4000-8000-0000000000e1", url: "https://www.instagram.com/reel/c1/", platform: "instagram", handle: "demo_creator_a", own: false,
  views: 1_200_000, x: 14, publishedAt: "2026-10-10T10:00:00Z", durationS: 24, format: "talking_head", blueprint: BLUEPRINT, transcript: TRANSCRIPT, ...over,
});

describe("remix provenance and views (no database)", () => {
  it("writes the plain 'based on' line", () => {
    expect(basedOnLine({ handle: "@demo_creator_a", platform: "instagram", own: false, views: 1_200_000, x: 14 })).toBe("Based on @demo_creator_a's reel, 1.2M views, 14x their normal");
    expect(basedOnLine({ handle: "examplebrand", platform: "tiktok", own: true, views: 48_200, x: 3.21 })).toBe("Based on your own TikTok, 48.2K views, 3.2x your normal");
    expect(basedOnLine({ handle: "x", platform: "youtube", own: false, views: null, x: null })).toBe("Based on @x's Short");
    expect([formatViews(950), formatViews(61_200), formatViews(150_000), formatViews(null)]).toEqual(["950", "61.2K", "150K", null]);
  });

  it("never shows the transcript to the Copywriter, only the checked blueprint and facts", () => {
    const v = remixView(source());
    expect(JSON.stringify(v)).not.toContain("Rowan from Maple");
    expect(v).toMatchObject({ basedOn: "Based on @demo_creator_a's reel, 1.2M views, 14x their normal", blueprint: { sourceHookLine: BLUEPRINT.hookLine, spokenWords: 60 } });
    expect(v.neverUse).toEqual(["@demo_creator_a", "Rowan", "Maple and Oak"]);
    expect(v.blueprint!.theirSpecifics).toEqual([]);
    const bare = remixView(source({ blueprint: null }));
    expect(bare.blueprint).toBeNull();
    expect(bare.missingBlueprint).toContain("don't guess its words");
    expect(bare.neverUse).toEqual(["@demo_creator_a"]);
  });

  it("gives the validator the transcript and the creator's terms; your own posts are yours to reuse", () => {
    expect(remixRulesFor(source())).toMatchObject({ sourceText: TRANSCRIPT, hookLine: BLUEPRINT.hookLine, theirTerms: ["@demo_creator_a", "@demo_creator_a", "Rowan", "Maple and Oak"], sourceBeats: 4, sourceWords: 60 });
    expect(remixRulesFor(source({ own: true }))).toMatchObject({ theirTerms: [], copiedRunError: 60 });
    // Lower-case descriptions in swapOut are advice only, so the owner's own niche words never fail a script.
    const vague = source({ blueprint: { ...BLUEPRINT, swapOut: ["@demo_creator_a", "Dana", "cabinets and kitchen as the trade", "kitchen", "$2,400 figure"] } });
    expect(remixRulesFor(vague).theirTerms).toEqual(["@demo_creator_a", "@demo_creator_a", "Dana", "$2,400 figure"]);
    expect(remixView(vague).neverUse).toEqual(["@demo_creator_a", "Dana", "$2,400 figure"]);
    expect(remixView(vague).blueprint!.theirSpecifics).toEqual(["cabinets and kitchen as the trade", "kitchen"]);
  });

  it("matches topics on content words and scores proven-ness on views and times-normal", () => {
    expect(topicMatch("cheap kitchen quotes", "The cheapest cabinet quote we got was missing three things in the kitchen")).toBeGreaterThanOrEqual(0.5);
    expect(topicMatch("tile grout colours", "The cheapest cabinet quote")).toBe(0);
    expect(provenScore(1_000_000, 16)).toBe(1);
    expect(provenScore(5_000, 2)).toBeLessThan(provenScore(500_000, 2));
  });
});

describe("free keywords for a remix", () => {
  it("skips words the script will say anyway, and spreads concurrent pieces over different words", async () => {
    const { freeKeywords } = await import("../src/packet.ts");
    const willSay = "The cheapest cabinet quote was missing three things";
    const words = freeKeywords("What a cheap cabinet quote leaves out", [], willSay, "a");
    expect(words.some((w) => ["CABINET", "QUOTE", "CHEAPEST"].includes(w))).toBe(false);
    expect(words.length).toBe(3);
    const firsts = new Set(["a", "b", "c", "d", "e", "f"].map((seed) => freeKeywords("", [], "", seed)[0]));
    expect(firsts.size).toBeGreaterThan(1);
  });
});

describe("prompt assembly (no database)", () => {
  it("a remix prompt says what to keep and what to change, and carries the blueprint as data", () => {
    const brief = { mode: "remix", remix: remixView(source()), ownWinners: { yourNormalViews: 1000, posts: [] }, content: { id: "c" } };
    const p = writeScriptPrompt({ brief, hooks: [], sources: { proof: [], cited: [], recentStats: [], proofDetail: [] }, keywordSuggestions: ["ledger"], reservedKeyword: null });
    for (const line of REMIX_RULES) expect(p).toContain(line);
    expect(p).toContain(BLUEPRINT.hookLine);
    expect(p).toContain("brief.ownWinners");
    expect(p).not.toContain("Rowan from Maple");
    const original = writeScriptPrompt({ brief: { mode: "original", remix: null }, hooks: [], sources: { proof: [], cited: [], recentStats: [], proofDetail: [] }, keywordSuggestions: [], reservedKeyword: null });
    expect(original).not.toContain(REMIX_RULES[0]);
  });

  it("the agent prompt remixes when there's a source, and looks for one first when there isn't", () => {
    const packet = { brief: { mode: "remix", remix: remixView(source()) } };
    const remix = writeScriptAgentPrompt("c1", 2, null, "remix", packet);
    expect(remix).toContain(REMIX_RULES[1]);
    expect(remix).toContain(BLUEPRINT.hookLine);
    expect(remix).toContain("Don't read files, log progress or fetch any of it again");
    expect(remix).toContain("Leave out body and hookText");
    expect(remix).not.toContain("provenPostsOnThisTopic");
    const original = writeScriptAgentPrompt("c1", 2, null, "original", { brief: { mode: "original" }, provenPostsOnThisTopic: [] });
    expect(original).toContain("provenPostsOnThisTopic lists proven posts");
    expect(original).toContain("scripting_use_remix_source");
    expect(original).toContain(REMIX_RULES[2]);
    // Without a packet the agent fetches what it needs itself.
    expect(writeScriptAgentPrompt("c1", 2, null, "original")).toContain("scripting_find_remix_sources");
    // A revision keeps the source decision it already made.
    expect(writeScriptAgentPrompt("c1", 2, { notes: "Shorter" }, "original", {})).not.toContain("provenPostsOnThisTopic lists");
  });
});

const HAS_DB = await hasTestDatabase();
let db: Awaited<ReturnType<typeof testDb>> | undefined;
let sql: Sql;

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await testDb("attentionos_test_scripting_remix");
  sql = db.sql;
});
afterAll(async () => {
  await db?.drop();
});

async function seedSource(ws: WorkspaceContext, opts: { blueprint?: boolean; id?: string; own?: boolean; views?: number; x?: number } = {}): Promise<string> {
  let creatorId: string | null = null;
  if (opts.own) {
    const [c] = await ws.sql<{ id: string }[]>`insert into tracked_creators (workspace_id, platform, handle, tier, active) values (${ws.id}, 'instagram', 'examplebrand', 'own', true)
      on conflict (workspace_id, platform, handle) do update set tier = 'own' returning id`;
    creatorId = c!.id;
  }
  const pid = opts.id ?? `p${Math.random().toString(36).slice(2, 8)}`;
  const [p] = await ws.sql<{ id: string }[]>`
    insert into external_posts (workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, views, x_score, is_outlier, transcript, spoken_hook, caption)
    values (${ws.id}, ${creatorId}, 'instagram', ${pid}, ${opts.own ? "examplebrand" : "demo_creator_a"}, ${`https://www.instagram.com/reel/${pid}/`}, ${new Date(NOW.getTime() - 3 * 86_400_000)},
            ${opts.views ?? 1_200_000}, ${opts.own ? null : (opts.x ?? 14)}, ${!opts.own}, ${TRANSCRIPT}, ${BLUEPRINT.hookLine}, 'Cabinet quote checklist')
    returning id`;
  if (opts.blueprint !== false) {
    await ws.sql`insert into teardowns (workspace_id, external_post_id, platform, author_handle, url, analysis_md, fingerprint)
      values (${ws.id}, ${p!.id}, 'instagram', 'demo_creator_a', 'https://www.instagram.com/reel/c1/', 'analysis', ${ws.sql.json({ facets: { blueprint: BLUEPRINT } })})`;
  }
  return p!.id;
}

const HOOK = "The cheapest remodel quote you get is missing three things.";
const PROOF = "Last year we tracked 42 projects, and the fixed-scope ones finished 18 percent under the first quote.";
const PLAY = "First, the trades that open the walls. Second, the permit and the inspection days. Third, hauling the old kitchen away.";
const CLOSE = "Ask for those three in writing before the cheapest quote wins. Comment BLUEPRINT and I'll send you the checklist.";

function remixPackage(postUrl: string, beats = [
  { role: "hook", text: HOOK }, { role: "proof", text: PROOF }, { role: "play", text: PLAY }, { role: "close", text: CLOSE },
]) {
  return {
    title: "The cheap quote is missing three things",
    body: beats.map((b) => b.text).join(" "),
    beats,
    hookText: HOOK,
    hookSource: { hookId: null, pattern: "cost-of-mistake", origin: "competitor", ref: postUrl },
    cta: { type: "comment_keyword", keyword: "blueprint" },
    claimLedger: [
      { id: "c1", claim: "We tracked 42 projects last year", verdict: "PASS", source: "proof:project-tracker" },
      { id: "c2", claim: "Fixed-scope projects finished 18 percent under the first quote", verdict: "PASS", source: "proof:project-tracker" },
    ],
    captions: validCaptions(),
  };
}

describe.skipIf(!HAS_DB)(`remix scripts with a database${NEEDS_DB}`, () => {
  it("the brief carries the remix view and the owner's best posts, never the transcript", async () => {
    const ws = await makeWorkspace(sql);
    const postId = await seedSource(ws);
    const contentId = await makeContent(ws, { source_refs: [{ type: "external_post", id: postId, url: "https://www.instagram.com/reel/c1/" }] });
    // An own published post made here, with its approved script: the owner's trusted words.
    const ownContent = await makeContent(ws, { title: "Own winner" });
    await ws.sql`insert into scripts (workspace_id, content_id, version, body, hook_text, hook_source, status) values (${ws.id}, ${ownContent}, 1, 'Plan it once. Build it once.', 'Plan it once.', ${ws.sql.json({ pattern: "contrarian" })}, 'approved')`;
    const [post] = await ws.sql<{ id: string }[]>`insert into posts (workspace_id, content_id, platform, provider, status, idempotency_key, url)
      values (${ws.id}, ${ownContent}, 'instagram', 'zernio', 'published', 'k-own', 'https://www.instagram.com/reel/own/') returning id`;
    await ws.sql`insert into post_metrics (workspace_id, post_id, views, x_score) values (${ws.id}, ${post!.id}, 9000, 4.5)`;

    const brief = await getContentBrief(ws, contentId);
    expect(brief.mode).toBe("remix");
    expect(brief.remix).toMatchObject({ basedOn: "Based on @demo_creator_a's reel, 1.2M views, 14x their normal", blueprint: { sourceHookLine: BLUEPRINT.hookLine } });
    expect(brief.ownWinners.posts[0]).toMatchObject({ hook: "Plan it once.", script: "Plan it once. Build it once.", timesYourNormal: 4.5 });
    expect(JSON.stringify(brief)).not.toContain("Rowan from Maple");

    // The remixed post is a structure, never a source of facts.
    const sources = await getClaimSources(ws, contentId);
    expect(sources.cited).toEqual([]);
  });

  it("validates a close adaptation, and fails the creator's name or numbers", async () => {
    const ws = await makeWorkspace(sql);
    const postId = await seedSource(ws);
    const url = "https://www.instagram.com/reel/c1/";
    const contentId = await makeContent(ws, { source_refs: [{ type: "external_post", id: postId, url }] });
    const content = (await getContent(ws, contentId))!;

    const close = await validateForContent(ws, content, remixPackage(url));
    expect(close.report.errors).toEqual([]);

    const named = await validateForContent(ws, content, remixPackage(url, [
      { role: "hook", text: HOOK }, { role: "proof", text: `${PROOF} Maple and Oak found the same.` }, { role: "play", text: PLAY }, { role: "close", text: CLOSE },
    ]));
    expect(named.report.errors.map((e) => e.code)).toContain("remix.their_term");

    const theirs = remixPackage(url, [{ role: "hook", text: HOOK }, { role: "proof", text: "One fix cost 14000 dollars last spring." }, { role: "play", text: PLAY }, { role: "close", text: CLOSE }]);
    theirs.claimLedger = [{ id: "c1", claim: "One fix cost 14000 dollars", verdict: "PASS", source: url }];
    const r = await validateForContent(ws, content, theirs);
    expect(r.report.errors.map((e) => e.code)).toContain("remix.source_number");
  });

  it("the code-driven writer puts the remix rules and blueprint in the prompt and saves through the checks", async () => {
    const ws = await makeWorkspace(sql);
    const postId = await seedSource(ws);
    const url = "https://www.instagram.com/reel/c1/";
    const contentId = await makeContent(ws, { source_refs: [{ type: "external_post", id: postId, url }] });
    const prompts: string[] = [];
    const model: ScriptModel = async ({ prompt }) => (prompts.push(prompt), remixPackage(url));
    const out = await runWriteScript({ ws, actor: "agent:copywriter", contentId, model });
    expect(out.ok).toBe(true);
    expect(prompts[0]).toContain(REMIX_RULES[0]);
    expect(prompts[0]).toContain(BLUEPRINT.hookLine);
    expect(prompts[0]).not.toContain("Rowan from Maple");
  });

  it("finds proven posts for a topic, attaches one, and starts a waiting script when its teardown lands", async () => {
    const ws = await makeWorkspace(sql);
    const ready = await seedSource(ws, { id: "ready" });
    const raw = await seedSource(ws, { id: "raw", blueprint: false, views: 30_000, x: 3 });
    // Own posts: median 1,000; one breakout on the same topic.
    for (const [i, v] of [900, 1000, 1100].entries()) await seedSource(ws, { id: `own${i}`, own: true, views: v, blueprint: false });
    const ownHit = await seedSource(ws, { id: "own-hit", own: true, views: 5000, blueprint: false });

    const found = await findRemixSources(ws, { topic: "cheapest cabinet quote" });
    expect(found.map((f) => f.externalPostId)).toEqual(expect.arrayContaining([ready, raw, ownHit]));
    expect(found[0]).toMatchObject({ externalPostId: ready, ready: true, topic: "What a cheap quote leaves out", basedOn: "Based on @demo_creator_a's reel, 1.2M views, 14x their normal" });
    expect(found.find((f) => f.externalPostId === ownHit)).toMatchObject({ own: true, timesTheirNormal: 4.8, basedOn: "Based on your own reel, 5K views, 4.8x your normal" });
    // Own posts that didn't beat the owner's normal aren't proven.
    expect(found.some((f) => f.basedOn.includes("1K views"))).toBe(false);
    expect(await findRemixSources(ws, { topic: "tile grout colours" })).toEqual([]);

    const contentId = await makeContent(ws, { title: "A script about cheap quotes" });
    const tool = scriptingTools.find((t) => t.name === "scripting_use_remix_source")!;
    // The Copywriter mid-run can only remix a post with a checked blueprint; it gets the teardown queued instead.
    await expect(tool.handler({ ws, actor: "agent:copywriter" }, tool.input.parse({ contentId, externalPostId: raw }) as never)).rejects.toThrow("no checked blueprint");
    expect((await getContent(ws, contentId))!.source_refs ?? []).toEqual([]);
    await ws.sql`delete from agent_runs where workspace_id = ${ws.id} and job_id = 'research.teardown-prep'`;
    // A person can attach it; the script then waits for the teardown.
    const used = (await tool.handler({ ws, actor: "user:local" }, tool.input.parse({ contentId, externalPostId: raw }) as never)) as { teardownQueued: boolean };
    expect(used.teardownQueued).toBe(true);
    const content = (await getContent(ws, contentId))!;
    expect(content.source_refs![0]).toMatchObject({ type: "external_post", id: raw });
    expect(content.brief).toMatchObject({ kind: "remix", remixOf: { externalPostId: raw, line: "Based on @demo_creator_a's reel, 30K views, 3x their normal" } });
    const [prep] = await ws.sql<{ job_id: string; input: unknown }[]>`select job_id, input from agent_runs where workspace_id = ${ws.id} and job_id = 'research.teardown-prep'`;
    expect(prep).toEqual({ job_id: "research.teardown-prep", input: { externalPostId: raw, reuseBlueprint: true, then: { jobId: "scripting.remix-ready", agent: "copywriter", input: { contentId } } } });
    // Already remixed: not offered again unless asked.
    expect((await findRemixSources(ws, { topic: "cheapest cabinet quote" })).some((f) => f.externalPostId === raw)).toBe(false);
    await expect(useRemixSource(ws, "agent:copywriter", { contentId, externalPostId: "00000000-0000-4000-8000-000000000999" })).rejects.toThrow("research library");

    // A script queued to wait for the teardown starts now.
    await ws.sql`insert into agent_runs (workspace_id, agent, job_id, trigger, status, input, run_after, created_by)
      values (${ws.id}, 'copywriter', 'scripting.write-script', 'handoff', 'queued', ${ws.sql.json({ contentId })}, ${new Date(NOW.getTime() + 30 * 60_000)}, 'agent:strategist')`;
    expect(await startWaitingScript(ws, contentId)).toBe(1);
    expect(await startWaitingScript(ws, contentId)).toBe(0);
  });
});

describe.skipIf(!HAS_DB)(`never a remix without its blueprint${NEEDS_DB}`, () => {
  it("waits for the teardown (asking again when none is on its way), gives up after failed teardowns, and retitles once it lands", async () => {
    const { remixGate, BLUEPRINT_RECHECK_MS } = await import("../src/remix.ts");
    const { writeScriptJob } = await import("../src/jobs/write-script.ts");
    expect(writeScriptJob.gate).toBeTypeOf("function");
    const ws = await makeWorkspace(sql);
    const raw = await seedSource(ws, { id: "gate-raw", blueprint: false });
    const url = "https://www.instagram.com/reel/gate-raw/";
    const contentId = await makeContent(ws, { title: "Remix: @demo_creator_a's 1.2M-view instagram post", source_refs: [{ type: "external_post", id: raw, url }] });
    await ws.sql`update content set created_at = ${new Date(NOW.getTime() - 3_600_000)} where id = ${contentId}`;

    // The save gate: a remix package for a source with no blueprint fails.
    const content = (await getContent(ws, contentId))!;
    expect((await validateForContent(ws, content, remixPackage(url))).report.errors.map((e) => e.code)).toContain("remix.no_blueprint");

    // The run gate: wait, and ask for the teardown (once while one is on its way).
    expect(await remixGate(ws, contentId)).toMatchObject({ wait: { ms: BLUEPRINT_RECHECK_MS } });
    expect(await remixGate(ws, contentId)).toMatchObject({ wait: { ms: BLUEPRINT_RECHECK_MS } });
    const preps = await ws.sql<{ input: unknown }[]>`select input from agent_runs where workspace_id = ${ws.id} and job_id = 'research.teardown-prep'`;
    expect(preps.map((p) => p.input)).toEqual([{ externalPostId: raw, reuseBlueprint: true, then: { jobId: "scripting.remix-ready", agent: "copywriter", input: { contentId } } }]);

    // A failed teardown is asked for again; after two failures the remix stops instead of guessing.
    await ws.sql`update agent_runs set status = 'succeeded' where workspace_id = ${ws.id} and job_id = 'research.teardown-prep'`;
    await ws.sql`insert into agent_runs (workspace_id, agent, job_id, status, input, created_at) values (${ws.id}, 'analyst', 'research.teardown', 'failed', ${ws.sql.json({ externalPostId: raw })}, ${NOW})`;
    expect(await remixGate(ws, contentId)).toMatchObject({ wait: {} });
    expect((await ws.sql`select 1 from agent_runs where workspace_id = ${ws.id} and job_id = 'research.teardown-prep' and status = 'queued'`).length).toBe(1);
    await ws.sql`update agent_runs set status = 'succeeded' where workspace_id = ${ws.id} and job_id = 'research.teardown-prep'`;
    await ws.sql`insert into agent_runs (workspace_id, agent, job_id, status, input, created_at) values (${ws.id}, 'analyst', 'research.teardown', 'failed', ${ws.sql.json({ externalPostId: raw })}, ${NOW})`;
    expect(await remixGate(ws, contentId)).toMatchObject({ stop: expect.stringContaining("Didn't write this remix") });

    // The blueprint lands: the script goes ahead and the placeholder title becomes the blueprint's topic.
    await ws.sql`insert into teardowns (workspace_id, external_post_id, platform, author_handle, url, analysis_md, fingerprint)
      values (${ws.id}, ${raw}, 'instagram', 'demo_creator_a', ${url}, 'analysis', ${ws.sql.json({ facets: { blueprint: BLUEPRINT } })})`;
    expect(await remixGate(ws, contentId)).toBeNull();
    expect((await getContent(ws, contentId))!.title).toBe("Remix: What a cheap quote leaves out");
    // A title someone wrote is never replaced.
    const named = await makeContent(ws, { title: "Cheap quotes, explained", source_refs: [{ type: "external_post", id: raw, url }] });
    expect(await remixGate(ws, named)).toBeNull();
    expect((await getContent(ws, named))!.title).toBe("Cheap quotes, explained");
    // Originals pass straight through.
    expect(await remixGate(ws, await makeContent(ws))).toBeNull();
  });

  it("a script for an older idea that only cited a post doesn't block a proper remix of it", async () => {
    const ws = await makeWorkspace(sql);
    const post = await seedSource(ws, { id: "cited-only" });
    const url = "https://www.instagram.com/reel/cited-only/";
    const old = await makeContent(ws, { title: "Use its structure", source_refs: [{ type: "external_post", id: post, url }] });
    await ws.sql`update content set status = 'scripted' where id = ${old}`;
    expect((await findRemixSources(ws, { topic: "cheapest cabinet quote" })).find((f) => f.externalPostId === post)).toMatchObject({ alreadyUsed: false });
    // Filmed: it's taken.
    await ws.sql`update content set status = 'filming' where id = ${old}`;
    expect((await findRemixSources(ws, { topic: "cheapest cabinet quote" })).some((f) => f.externalPostId === post)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)(`hook classifier output${NEEDS_DB}`, () => {
  it("is stored through onOutput, the hook the runner calls for toolless jobs", async () => {
    const ws = await makeWorkspace(sql);
    const id = await makeHook(ws, { origin: "competitor", pattern: "unclassified", text: "Kitchens are fun to plan with friends." });
    const ctx = { ws, input: { limit: 40 }, runId: "run-1", progress: async () => {} } as never;
    await classifyHooksJob.prompt(ctx);
    await classifyHooksJob.onOutput!(ctx, { items: [{ id, pattern: "pov-identity", abstract: "[Activity] is better with [people]." }] });
    const [h] = await ws.sql<{ pattern: string; abstract: string }[]>`select pattern, abstract from hooks where id = ${id}`;
    expect(h).toEqual({ pattern: "pov-identity", abstract: "[Activity] is better with [people]." });
  });
});

describe.skipIf(!HAS_DB)(`the write-script work packet and one-call save${NEEDS_DB}`, () => {
  it("packs everything the draft needs (never the transcript), and the save tool takes patches", async () => {
    const ws = await makeWorkspace(sql);
    const postId = await seedSource(ws);
    const url = "https://www.instagram.com/reel/c1/";
    const contentId = await makeContent(ws, { source_refs: [{ type: "external_post", id: postId, url }] });
    const { writePacket } = await import("../src/packet.ts");
    const packet = await writePacket(ws, contentId);
    expect(packet.brief.mode).toBe("remix");
    expect(packet.claimSources.proof[0]).toMatchObject({ ref: "proof:project-tracker" });
    expect((packet.keyword as { freeToUse: string[] }).freeToUse.length).toBeGreaterThan(0);
    // A remix keeps its source's hook, so the hook audit is left out.
    expect(Object.keys(packet.method)).toEqual(["spoken-humanizer", "claim-ledger", "captions"]);
    expect(packet.brandKit["brand/voice.md"]).toBeDefined();
    expect(packet.captionRules.platforms.length).toBeGreaterThan(0);
    expect("provenPostsOnThisTopic" in packet).toBe(false);
    expect(JSON.stringify(packet)).not.toContain("Rowan from Maple");
    // A remix's keywords come from its topic, never from a placeholder title ("1.2M-view instagram post").
    const placeholder = await makeContent(ws, { title: "Remix: @demo_creator_a's 1.2M-view instagram post", source_refs: [{ type: "external_post", id: postId, url }] });
    const words = ((await writePacket(ws, placeholder)).keyword as { freeToUse: string[] }).freeToUse;
    expect(words.length).toBeGreaterThan(0);
    expect(words.some((w) => /VIEW|INSTAGRAM|POST/.test(w))).toBe(false);

    const save = scriptingTools.find((t) => t.name === "scripting_save_script")!;
    const call = (input: Record<string, unknown>) => save.handler({ ws, actor: "agent:copywriter" }, save.input.parse({ contentId, ...input }) as never) as Promise<Record<string, unknown>>;
    await expect(call({ patch: { title: "x" } })).rejects.toThrow("no earlier package");
    // First save: body and hookText left out; the play beat is too long to fit the window.
    const { body: _b, hookText: _h, ...pkg } = remixPackage(url);
    const long = { ...pkg, beats: pkg.beats.map((b) => (b.role === "play" ? { ...b, text: `${PLAY} ${"Then check the hinges, the handles and the trim. ".repeat(12)}` } : b)) };
    const first = await call({ package: long });
    expect(first.ok).toBe(false);
    expect((first.errors as { code: string }[]).map((e) => e.code)).toContain("length.too_long");
    expect(first.next).toContain("patch");
    // The fix sends one beat, not the script.
    const second = await call({ patch: { beatEdits: [{ index: 2, text: PLAY }] } });
    expect(second).toMatchObject({ ok: true, version: 2 });
    expect(second.next).toContain("don't save again");
  });
});

import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolDefinition, WorkspaceContext } from "@attentionos/core";
import { createTestWorkspace, DEMO_BRAND_DIR } from "@attentionos/module-research/testing";
import strategyModule, { runBrief } from "../src/index.ts";
import { weekStart } from "../src/repo.ts";

const NOW = new Date("2026-10-12T10:00:00Z"); // Monday 06:00 in New York
const tool = (name: string) => strategyModule.tools.find((t) => t.name === name) as ToolDefinition;
const call = (ws: WorkspaceContext, name: string, input: Record<string, unknown>) => tool(name).handler({ ws, actor: "agent:strategist" }, tool(name).input.parse(input));

function brandCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "aos-strategy-")), "brand");
  cpSync(DEMO_BRAND_DIR, dir, { recursive: true });
  return dir;
}

async function seedResearch(ws: WorkspaceContext) {
  await ws.sql`insert into trends (workspace_id, source_id, external_id, title, url, heat, status, story, last_seen_at, film_by)
    values (${ws.id}, 'industry-feed', 'e1', 'County permits move online', 'https://news.example.org/a', 82, 'kit',
            ${ws.sql.json({ header: "Permits just went online", hook: "x" })}, ${NOW}, ${new Date(NOW.getTime() + 20 * 3_600_000)})`;
  for (const [id, x] of [["o1", 4.4], ["o2", 3.1]] as const) {
    await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, x_score, is_outlier)
      values (${ws.id}, 'instagram', ${id}, 'demo_creator_a', ${`https://www.instagram.com/reel/${id}/`}, ${new Date(NOW.getTime() - 2 * 86_400_000)}, ${x}, true)`;
  }
}

describe("daily brief", () => {
  it("writes the slate as content rows with an approval, a notification and a drafting hand-off", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000201", brandDir: brandCopy(), now: () => NOW });
    await seedResearch(ws);
    const r = await runBrief(ws, { mode: "daily" });
    expect(r.created).toBe(true);
    expect(r.date).toBe("2026-10-12");
    // 1 kit-backed news reel, 2 remixes, talking heads, 1 offer; the empty news slot is backfilled when a fresh topic exists.
    expect(r.items.length).toBeGreaterThanOrEqual(6);
    expect(r.approvalRef).toMatch(/^ap-\d+$/);
    const news = r.items[0]!;
    expect(news).toMatchObject({ title: "Permits just went online", status: "idea", lane: "local-news-take", template: "news-greenscreen", ctaType: "follow" });
    expect(news.brief).toMatchObject({ briefDate: "2026-10-12", mode: "daily", slot: 1, kind: "news", laneName: "Local news take" });
    expect(news.brief.shootDirections).toContain("Plain background");
    // news film-by is capped by the trend's own deadline
    expect(news.filmBy).toBe(new Date(NOW.getTime() + 20 * 3_600_000).toISOString());

    const [approval] = await ws.sql`select ref, kind, subject_type, agent, summary from approvals where workspace_id = ${ws.id}`;
    expect(approval).toMatchObject({ kind: "other", subject_type: "daily_brief", agent: "strategist" });
    // Remix-first: the slate asks for 5 remixes (remixShare 0.7 of 7), keeps 1 news slot and the offer; only 2 proven
    // posts exist, so the rest is backfilled with talking heads.
    expect(approval!.summary).toMatch(/^Film today: \d+ pieces \(1 news reel, 2 outlier remixes, 1 offer piece, \d+ talking heads\)$/);
    const remixes = r.items.filter((i) => i.brief.kind === "remix");
    expect(remixes.map((i) => i.sourceRefs[0])).toEqual([
      { type: "external_post", id: expect.any(String), url: "https://www.instagram.com/reel/o1/" },
      { type: "external_post", id: expect.any(String), url: "https://www.instagram.com/reel/o2/" },
    ]);
    expect(remixes[0]!.brief.remixOf).toMatchObject({ handle: "demo_creator_a", own: false, x: 4.4, line: "Based on @demo_creator_a's reel, 4.4x their normal" });
    expect(remixes[0]!.brief.why).toContain("Based on @demo_creator_a's reel");
    const [msg] = await ws.sql`select body, ref from messages where workspace_id = ${ws.id}`;
    expect((msg!.body as { text: string }).text).toContain("1. Permits just went online · Local news take · film by");
    expect((msg!.body as { text: string }).text).toContain("3 remix slots left open");
    const runs = await ws.sql`select job_id, agent, input from agent_runs where workspace_id = ${ws.id} and job_id = 'strategy.draft-brief'`;
    expect(runs).toEqual([{ job_id: "strategy.draft-brief", agent: "strategist", input: { date: "2026-10-12", mode: "daily" } }]);
    // The Copywriter is asked for the five soonest filmable pieces, one run each, keyed by content id.
    const scripts = await ws.sql<{ input: { contentId: string; briefDate: string }; dedupe_key: string; agent: string }[]>`
      select input, dedupe_key, agent from agent_runs where workspace_id = ${ws.id} and job_id = 'scripting.write-script' order by created_at`;
    expect(scripts).toHaveLength(5);
    expect(r.scripts?.queued).toHaveLength(5);
    expect(r.scripts?.overCap).toBe(r.items.length - 5);
    expect(scripts.every((x) => x.agent === "copywriter" && x.dedupe_key === `write-script:${x.input.contentId}` && x.input.briefDate === "2026-10-12")).toBe(true);
    expect(scripts[0]!.input.contentId).toBe(news.id); // the news reel is due first
    expect((msg!.body as { text: string }).text).toContain("The Copywriter starts on 5 scripts (soonest first)");

    // Same day again: the existing brief comes back, nothing duplicated.
    const again = await runBrief(ws, { mode: "daily" });
    expect(again.created).toBe(false);
    expect(again.items.map((i) => i.id)).toEqual(r.items.map((i) => i.id));
    // Replanning archives the open ideas and plans fresh (remixes already used drop out).
    const re = await runBrief(ws, { mode: "daily", replan: true });
    expect(re.created).toBe(true);
    const [{ archived }] = (await ws.sql`select count(*)::int as archived from content where workspace_id = ${ws.id} and status = 'archived'`) as unknown as [{ archived: number }];
    expect(archived).toBe(r.items.length);
    // The archived ideas' queued scripts are cancelled, which frees today's allowance for the new slate.
    const states = await ws.sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from agent_runs where workspace_id = ${ws.id} and job_id = 'scripting.write-script' group by status order by status`;
    expect(states).toEqual([{ status: "cancelled", n: 5 }, { status: "queued", n: Math.min(5, re.items.length) }]);
  });

  it("caps automatic scripts per day, skips text pieces and never queues one twice", async () => {
    const ws = await createTestWorkspace({
      id: "00000000-0000-4000-8000-000000000207",
      brandDir: brandCopy(),
      now: () => NOW,
      config: { modules: { strategy: { settings: { autoScripts: { maxPerDay: 3, delayMinutes: 0 } } } } },
    });
    const r = await runBrief(ws, { mode: "daily" });
    expect(r.scripts?.queued).toHaveLength(3);
    // A batch edition on the same date shares the allowance, so nothing more is queued.
    const batch = await runBrief(ws, { mode: "batch" });
    expect(batch.scripts?.queued).toEqual([]);
    expect(batch.scripts?.overCap).toBe(batch.items.length);

    // Dedupe holds in every run state: a finished run's piece is never auto-scripted again.
    await ws.sql`update agent_runs set status = 'succeeded' where workspace_id = ${ws.id} and job_id = 'scripting.write-script'`;
    const { queueScriptsForBrief } = await import("../src/script-handoff.ts");
    const again = await queueScriptsForBrief(ws, r.items, { date: "2026-10-13", mode: "daily" });
    expect(again.deduped).toBe(3);
    expect(again.queued).toHaveLength(Math.min(3, r.items.length - 3));
    expect(again.queued.some((id) => r.scripts!.queued.includes(id))).toBe(false);
    const keys = await ws.sql<{ dedupe_key: string; n: number }[]>`
      select dedupe_key, count(*)::int as n from agent_runs where workspace_id = ${ws.id} and job_id = 'scripting.write-script' group by dedupe_key having count(*) > 1`;
    expect(keys).toEqual([]);
  });

  it("queues nothing when automatic scripts are off or the scripting module is", async () => {
    for (const [i, modules] of [
      [8, { strategy: { settings: { autoScripts: { enabled: false } } } }],
      [9, { scripting: { enabled: false } }],
    ] as const) {
      const ws = await createTestWorkspace({ id: `00000000-0000-4000-8000-00000000020${i}`, brandDir: brandCopy(), now: () => NOW, config: { modules } });
      const r = await runBrief(ws, { mode: "daily" });
      expect(r.created).toBe(true);
      expect(r.scripts?.queued).toEqual([]);
      const [{ n }] = (await ws.sql`select count(*)::int as n from agent_runs where workspace_id = ${ws.id} and job_id = 'scripting.write-script'`) as unknown as [{ n: number }];
      expect(n).toBe(0);
    }
  });

  it("plans a batch day from the preset's weekly target without news", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000202", brandDir: brandCopy(), now: () => NOW });
    await seedResearch(ws);
    const r = await runBrief(ws, { mode: "batch" });
    // 8 pieces: the offer, about 70% remixes (only 2 proven posts here) and talking heads; any slot that can't be
    // filled without repeating a recent topic is reported, never silently dropped.
    const unfilled = r.notes.some((n) => n.includes("couldn't be backfilled")) ? Number(/^(\d+) slot/.exec(r.notes.find((n) => n.includes("couldn't be backfilled"))!)![1]) : 0;
    expect(r.items.length + unfilled).toBe(8);
    expect(r.items.filter((i) => i.brief.kind === "remix")).toHaveLength(2);
    expect(r.items.filter((i) => i.brief.kind === "news")).toHaveLength(0);
    expect(r.items.filter((i) => i.brief.kind === "offer")).toHaveLength(1);
    expect(new Set(r.items.map((i) => i.lane)).size).toBeGreaterThanOrEqual(3);
  });

  it("computes the week start on Monday in the workspace time zone", () => {
    expect(weekStart(new Date("2026-10-14T15:00:00Z"), "America/New_York").toISOString()).toBe("2026-10-12T04:00:00.000Z");
    expect(weekStart(new Date("2026-10-12T03:00:00Z"), "America/New_York").toISOString()).toBe("2026-10-05T04:00:00.000Z");
  });
});

describe("strategy tools", () => {
  it("returns the brief and gates drafted headers on banned phrases and invented numbers", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000203", brandDir: brandCopy(), now: () => NOW });
    await seedResearch(ws);
    const r = await runBrief(ws, { mode: "daily" });
    const brief = (await call(ws, "strategy_get_todays_brief", {})) as { items: { contentId: string; kind: string; proof?: { numbers: { value: string }[] }; storyStructure?: string }[] };
    expect(brief.items).toHaveLength(r.items.length);
    const withProof = brief.items.find((i) => i.proof?.numbers.length)!;
    const value = withProof.proof!.numbers[0]!.value.match(/\d+/)![0];

    await expect(call(ws, "strategy_save_brief_item", { contentId: withProof.contentId, header: "Done in 9 weeks flat", hookIdea: "How we planned it", shootDirections: ["On site"] }))
      .rejects.toThrow(/proof inventory: 9/);
    await expect(call(ws, "strategy_save_brief_item", { contentId: withProof.contentId, header: "A real game changer", hookIdea: "How we planned it", shootDirections: ["On site"] }))
      .rejects.toThrow(/banned phrase/);
    expect(await call(ws, "strategy_save_brief_item", { contentId: withProof.contentId, header: `Built in ${value} weeks`, hookIdea: "The plan did the work", shootDirections: ["Walk the finished room", "Show the plan on paper"] }))
      .toEqual({ saved: true, contentId: withProof.contentId });
    const after = (await call(ws, "strategy_get_todays_brief", {})) as { items: { contentId: string; header?: string }[] };
    expect(after.items.find((i) => i.contentId === withProof.contentId)!.header).toBe(`Built in ${value} weeks`);
    expect(r.items.length).toBeGreaterThanOrEqual(5);
  });

  it("reports lane balance and funnel mix", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000204", brandDir: brandCopy(), now: () => NOW });
    const r = await runBrief(ws, { mode: "daily" });
    const bal = (await call(ws, "strategy_get_lane_balance", {})) as { lanes: { id: string; quota: number; thisWeek: number; left: number }[]; funnel: { actual: Record<string, number>; overLast: number } };
    const sum = bal.lanes.reduce((s, l) => s + l.thisWeek, 0);
    expect(sum).toBe(r.items.length);
    expect(bal.lanes.find((l) => l.id === "offer")).toMatchObject({ quota: 1, thisWeek: 1, left: 0 });
    expect(bal.funnel.overLast).toBe(r.items.length);
    expect(Object.values(bal.funnel.actual).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(99);
  });

  it("rejects concepts into brand/pillars.md and archives the idea", async () => {
    const brandDir = brandCopy();
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000205", brandDir, now: () => NOW });
    const r = await runBrief(ws, { mode: "daily" });
    const target = r.items.find((i) => i.brief.kind === "talking_head")!;
    expect(await call(ws, "strategy_reject_concept", { contentId: target.id, why: "too salesy" })).toEqual({ rejected: target.title, archived: true });
    expect(readFileSync(join(brandDir, "pillars.md"), "utf8")).toContain(`- 2026-10-12 · ${target.title} · too salesy`);
    const ideas = (await call(ws, "strategy_list_ideas", {})) as { count: number };
    expect(ideas.count).toBe(r.items.length - 1);
    await expect(call(ws, "strategy_reject_concept", {})).rejects.toThrow(/rejected concept/);
  });

  it("picks proof items with a cooldown and attaches them to ideas", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000206", brandDir: brandCopy(), now: () => NOW });
    const [c] = await ws.sql`insert into content (workspace_id, title, status) values (${ws.id}, 'Idea', 'idea') returning id`;
    const first = (await call(ws, "strategy_pick_proof_item", { kind: "case_study", attachTo: c!.id })) as { id: string; nameClient?: string; cooledDown?: string };
    expect(first.id).toBe("maple-kitchen");
    expect(first.nameClient).toContain("No consent");
    const again = (await call(ws, "strategy_pick_proof_item", { kind: "case_study" })) as { id: string; cooledDown?: string };
    expect(again.cooledDown).toContain("least recently used");
    const lane = (await call(ws, "strategy_pick_proof_item", { lane: "customer-question" })) as { id: string };
    expect(lane.id).toBe("permit-faq");
    await expect(call(ws, "strategy_pick_proof_item", { lane: "nope" })).rejects.toThrow(/No lane/);
  });
});

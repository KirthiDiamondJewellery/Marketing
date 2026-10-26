import { ToolError, type Sql, type WorkspaceContext } from "@attentionos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyClassifications, harvestCompetitorHooks, harvestOwnHooks, reserveKeyword, runWriteScript, saveScript, seededRandom, type ScriptModel,
} from "../src/index.ts";
import { scriptingTools } from "../src/tools/index.ts";
import { validPackage, withBeat } from "../../../packages/guardrails/test/fixtures.ts";
import { hasTestDatabase, makeContent, makeHook, makeWorkspace, NEEDS_DB, NOW, testDb } from "./helpers.ts";

const HAS_DB = await hasTestDatabase();
let db: Awaited<ReturnType<typeof testDb>> | undefined;
let sql: Sql;

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await testDb();
  sql = db.sql;
});
afterAll(async () => {
  await db?.drop();
});

const AGENT = "agent:copywriter" as const;
const USER = "user:owner" as const;

function tool(name: string) {
  const t = scriptingTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (ws: WorkspaceContext, input: Record<string, unknown>, actor: typeof AGENT | typeof USER = AGENT) => t.handler({ ws, actor }, t.input.parse(input) as never) as Promise<Record<string, unknown>>;
}

async function packageFor(ws: WorkspaceContext, over: Partial<ReturnType<typeof validPackage>> = {}) {
  const hookId = await makeHook(ws, { pattern: "cost-of-mistake", origin: "own" });
  const pkg = validPackage();
  return { ...pkg, hookSource: { ...pkg.hookSource, hookId }, ...over };
}

describe.skipIf(!HAS_DB)(`scripting with a database${NEEDS_DB}`, () => {
  describe("keyword ledger", () => {
    it("reserves, refuses collisions and words in the script, and suggests alternatives", async () => {
      const ws = await makeWorkspace(sql);
      const a = await makeContent(ws);
      const b = await makeContent(ws, { title: "Change orders explained" });
      const r1 = await reserveKeyword(ws, AGENT, { contentId: a, keyword: "Guide" });
      expect(r1).toMatchObject({ reserved: true, keyword: "guide" });
      const r2 = await reserveKeyword(ws, AGENT, { contentId: b, keyword: "guides" });
      expect(r2.reserved).toBe(false);
      if (!r2.reserved) {
        expect(r2.problems.errors.map((e) => e.code)).toEqual(["keyword.collision"]);
        expect(r2.suggestions.length).toBeGreaterThan(0);
        for (const s of r2.suggestions) expect(s.includes("guide") || "guide".includes(s)).toBe(false);
      }
      const r3 = await reserveKeyword(ws, AGENT, { contentId: b, keyword: "scope", scriptText: "Get a fixed scope." });
      expect(r3.reserved).toBe(false);
      // Re-reserving for the same content swaps the unused reservation.
      const r4 = await reserveKeyword(ws, AGENT, { contentId: a, keyword: "ledger" });
      expect(r4).toMatchObject({ reserved: true, released: "guide" });
      const words = await ws.sql<{ word: string }[]>`select word::text as word from keywords where workspace_id = ${ws.id} order by word`;
      expect(words.map((w) => w.word)).toEqual(["ledger"]);
    });

    it("the unique constraint is case-insensitive", async () => {
      const ws = await makeWorkspace(sql);
      await ws.sql`insert into keywords (workspace_id, word) values (${ws.id}, 'Blueprint')`;
      await expect(ws.sql`insert into keywords (workspace_id, word) values (${ws.id}, 'BLUEPRINT')`).rejects.toMatchObject({ code: "23505" });
    });

    it("concurrent reservations of the same word: exactly one wins", async () => {
      const ws = await makeWorkspace(sql);
      const ids = await Promise.all([1, 2, 3, 4].map((i) => makeContent(ws, { title: `Piece ${i}` })));
      const results = await Promise.all(ids.map((id) => reserveKeyword(ws, AGENT, { contentId: id, keyword: "permit" })));
      expect(results.filter((r) => r.reserved)).toHaveLength(1);
      for (const r of results.filter((x) => !x.reserved)) {
        if (!r.reserved) expect(["keyword.reused", "keyword.taken"]).toContain(r.problems.errors[0]!.code);
      }
    });

    it("concurrent reservations of overlapping words: the lock lets only one through", async () => {
      const ws = await makeWorkspace(sql);
      const [a, b] = await Promise.all([makeContent(ws), makeContent(ws, { title: "Other" })]);
      const results = await Promise.all([
        reserveKeyword(ws, AGENT, { contentId: a!, keyword: "drywall" }),
        reserveKeyword(ws, AGENT, { contentId: b!, keyword: "drywalls" }),
      ]);
      expect(results.filter((r) => r.reserved)).toHaveLength(1);
    });

    it("tool: suggestions without a keyword, reservation with one", async () => {
      const ws = await makeWorkspace(sql);
      const id = await makeContent(ws, { title: "Allowance lines in remodel contracts" });
      const s = await tool("scripting_reserve_keyword")(ws, { contentId: id });
      expect((s.suggestions as string[]).length).toBeGreaterThan(0);
      expect(await tool("scripting_reserve_keyword")(ws, { contentId: id, keyword: "allowance" })).toMatchObject({ reserved: true, keyword: "ALLOWANCE" });
    });
  });

  describe("saving scripts", () => {
    it("a passing script is versioned, sent for review and updates the content", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const pkg = await packageFor(ws);
      const res = await saveScript(ws, AGENT, { contentId, package: pkg });
      expect(res.report.errors).toEqual([]);
      expect(res).toMatchObject({ saved: true, ok: true, version: 1, stop: false });
      expect(res.approvalRef).toMatch(/^ap-\d+$/);
      const [content] = await ws.sql<{ status: string; hook_pattern: string; keyword_id: string | null }[]>`select status, hook_pattern, keyword_id from content where id = ${contentId}`;
      expect(content).toMatchObject({ status: "scripted", hook_pattern: "cost-of-mistake" });
      expect(content!.keyword_id).not.toBeNull();
      const [approval] = await ws.sql<{ kind: string; status: string; summary: string }[]>`select kind, status, summary from approvals where workspace_id = ${ws.id}`;
      expect(approval).toMatchObject({ kind: "script", status: "pending", summary: "Script ready for review: Why remodel budgets break early" });
      const [hook] = await ws.sql<{ uses: number }[]>`select uses from hooks where id = ${pkg.hookSource.hookId}`;
      expect(hook!.uses).toBe(1);
      const [row] = await ws.sql<{ validator_report: { ok: boolean }; hook_source: { hook_id: string }; status: string }[]>`select validator_report, hook_source, status from scripts where id = ${res.scriptId}`;
      expect(row).toMatchObject({ status: "draft", validator_report: { ok: true }, hook_source: { hook_id: pkg.hookSource.hookId } });

      // A second passing version supersedes the first draft and its pending approval.
      const again = await saveScript(ws, AGENT, { contentId, package: pkg });
      expect(again.version).toBe(2);
      const statuses = await ws.sql<{ version: number; status: string }[]>`select version, status from scripts where content_id = ${contentId} order by version`;
      expect(statuses.map((s) => s.status)).toEqual(["superseded", "draft"]);
      const approvals = await ws.sql<{ status: string }[]>`select status from approvals where workspace_id = ${ws.id} order by requested_at, ref`;
      expect(approvals.map((a) => a.status).sort()).toEqual(["pending", "revised"]);
    });

    it("a failing script is stored as a draft with fixes; the third failure in a row says stop", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const bad = { ...(await packageFor(ws)), ...withBeat("hook", "So here's the deal, your remodel budget breaks early."), hookSource: (await packageFor(ws)).hookSource };
      const r1 = await saveScript(ws, AGENT, { contentId, package: bad });
      expect(r1).toMatchObject({ saved: true, ok: false, failedDrafts: 1, stop: false, approvalRef: null });
      expect(r1.report.errors.map((e) => e.code)).toContain("script.banned_opener");
      expect(r1.message).toContain("2 revisions left");
      const r2 = await saveScript(ws, AGENT, { contentId, package: bad });
      expect(r2).toMatchObject({ failedDrafts: 2, stop: false });
      const r3 = await saveScript(ws, AGENT, { contentId, package: bad });
      expect(r3).toMatchObject({ failedDrafts: 3, stop: true });
      expect(r3.message).toContain("Stop revising");
      const [c] = await ws.sql<{ status: string }[]>`select status from content where id = ${contentId}`;
      expect(c!.status).toBe("idea");
      expect((await ws.sql`select 1 from approvals where workspace_id = ${ws.id}`).length).toBe(0);
    });

    it("refuses approval by an agent, and by a person when checks fail", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const pkg = await packageFor(ws);
      await expect(saveScript(ws, AGENT, { contentId, package: pkg, status: "approved" })).rejects.toBeInstanceOf(ToolError);
      const bad = { ...pkg, body: `${pkg.body} Extra.` };
      await expect(saveScript(ws, USER, { contentId, package: bad, status: "approved" })).rejects.toThrow(/can't be approved/);
      const ok = await saveScript(ws, USER, { contentId, package: pkg, status: "approved" });
      expect(ok).toMatchObject({ ok: true, approvalRef: null });
      const [row] = await ws.sql<{ status: string }[]>`select status from scripts where id = ${ok.scriptId}`;
      expect(row!.status).toBe("approved");
    });

    it("a shape error is not saved", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const res = await saveScript(ws, AGENT, { contentId, package: { title: "only a title" } });
      expect(res).toMatchObject({ saved: false, ok: false });
      expect(res.report.errors[0]!.code).toBe("script.shape");
    });

    it("hook_source must point at a real bank hook; keywords used by other content fail", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const other = await makeContent(ws, { title: "Other" });
      await reserveKeyword(ws, AGENT, { contentId: other, keyword: "blueprint" });
      const pkg = { ...validPackage(), hookSource: { hookId: "11111111-1111-4111-8111-111111111111", pattern: "cost-of-mistake", origin: "own" as const } };
      const res = await tool("scripting_validate_script")(ws, { contentId, package: pkg });
      const codes = (res.errors as { code: string }[]).map((e) => e.code);
      expect(codes).toEqual(expect.arrayContaining(["hook_source.unknown_hook", "keyword.reused"]));
    });
  });

  describe("tools", () => {
    it("brief, claim sources, hooks and recent scripts", async () => {
      const ws = await makeWorkspace(sql);
      const [trend] = await ws.sql<{ id: string }[]>`
        insert into trends (workspace_id, source_id, external_id, title, url) values (${ws.id}, 'rss-1', 'x1', 'Remodel costs report', 'https://example.com/report') returning id`;
      const contentId = await makeContent(ws, { source_refs: [{ type: "trend", id: trend!.id }, { type: "manual", url: "https://example.com/permits" }] });

      const brief = await tool("scripting_get_content_brief")(ws, { contentId });
      expect(brief).toMatchObject({ content: { id: contentId, ctaType: "comment_keyword" }, rules: { wpm: 160, lengthSeconds: [15, 60] } });
      expect(brief.readFirst).toContain("brand/voice.md");

      const sources = await tool("scripting_get_claim_sources")(ws, { contentId });
      expect((sources.proof as { ref: string }[]).map((p) => p.ref)).toEqual(["proof:project-tracker", "proof:maple-street-kitchen"]);
      expect((sources.cited as { ref: string; url: string }[]).map((c) => c.url)).toEqual(["https://example.com/report", "https://example.com/permits"]);

      await makeHook(ws, { origin: "own", pattern: "contrarian", text: "Our own opener words." });
      await makeHook(ws, { origin: "competitor", pattern: "myth-bust", text: "Untrusted scraped words", abstract: "[Belief] is a myth because [reason]." });
      const hooks = (await tool("scripting_list_hooks")(ws, { bank: "all" })).hooks as { origin: string; text?: string; structure: string }[];
      const comp = hooks.find((h) => h.origin === "competitor")!;
      expect(comp.text).toBeUndefined();
      expect(comp.structure).toBe("[Belief] is a myth because [reason].");
      expect(hooks.find((h) => h.origin === "own")!.text).toBe("Our own opener words.");
      expect(JSON.stringify(hooks)).not.toContain("Untrusted scraped words");

      const picks = await tool("scripting_pick_hooks")(ws, { count: 2 });
      expect(picks).toMatchObject({ weights: "uniform" });
      expect(JSON.stringify(picks)).not.toContain("Untrusted scraped words");

      await saveScript(ws, AGENT, { contentId, package: await packageFor(ws) });
      const recent = await tool("scripting_list_recent_scripts")(ws, { limit: 5 });
      expect((recent.scripts as { numbersUsed: string[] }[])[0]!.numbersUsed).toEqual(["42", "18 percent"]);

      // The next piece sees 42 as a spent stat (warning, not error).
      const next = await makeContent(ws, { title: "Second piece" });
      const pkg2 = { ...(await packageFor(ws)), cta: { type: "comment_keyword" as const, keyword: "permits" } };
      pkg2.beats = pkg2.beats.map((b) => (b.role === "close" ? { ...b, text: b.text.replace("BLUEPRINT", "PERMITS") } : b));
      pkg2.body = pkg2.beats.map((b) => b.text).join(" ");
      pkg2.captions = JSON.parse(JSON.stringify(pkg2.captions).replaceAll("BLUEPRINT", "PERMITS"));
      const v = await tool("scripting_validate_script")(ws, { contentId: next, package: pkg2 });
      expect(v.ok).toBe(true);
      expect((v.warnings as { code: string }[]).map((w) => w.code)).toContain("claims.spent_stat");
    });

    it("captions and text posts are validated before saving", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      await saveScript(ws, AGENT, { contentId, package: await packageFor(ws) });
      const caps = validPackage().captions as Record<string, Record<string, unknown>>;
      const bad = await tool("scripting_save_captions")(ws, { contentId, captions: { ...caps, tiktok: { caption: "Comment BLUEPRINT", hashtags: ["#designbuild", "#remodeling", "#construction"] } } });
      expect(bad.saved).toBe(false);
      expect((bad.errors as { code: string }[]).map((e) => e.code)).toContain("captions.comment_keyword_off_instagram");
      const good = await tool("scripting_save_captions")(ws, { contentId, captions: caps });
      expect(good).toMatchObject({ saved: true, version: 1 });

      const rubric = { hook: 8, clarity: 9, usefulness: 8, accuracy: 9, formatting: 8, cta: 8 };
      const res = await tool("scripting_save_text_posts")(ws, {
        weekOf: "2026-10-12",
        posts: [
          { platform: "x", text: "Remodel budgets break in week one, not at demolition." },
          { platform: "linkedin", text: "Most remodel overruns start with the plan.\n\nHere is the fix.", hashtags: ["#designbuild", "#remodeling", "#construction"], rubric: { hook: 10, clarity: 10, usefulness: 9, accuracy: 6, formatting: 9, cta: 9 } },
          { platform: "linkedin", text: "Most remodel overruns start with the plan.\n\nHere is the fix.", hashtags: ["#designbuild", "#remodeling", "#construction"], rubric },
        ],
      });
      const results = res.results as { saved: boolean; errors?: { code: string }[]; approvalRef?: string }[];
      expect(results.map((r) => r.saved)).toEqual([true, false, true]);
      expect(results[1]!.errors!.map((e) => e.code)).toEqual(["rubric.below_floor"]);
      const kinds = await ws.sql<{ kind: string }[]>`select kind from content where workspace_id = ${ws.id} and created_by = ${AGENT} order by kind`;
      expect(kinds.map((k) => k.kind)).toEqual(["longform", "text"]);
    });
  });

  describe("decisions on script approvals", () => {
    const decide = (ws: WorkspaceContext, ref: string, status: string, by: string, note: string | null = null) =>
      ws.sql`update approvals set status = ${status}, decided_at = now(), decided_by = ${by}, decision_note = ${note} where workspace_id = ${ws.id} and ref = ${ref}`;
    const scriptStatuses = async (ws: WorkspaceContext, contentId: string) =>
      (await ws.sql<{ status: string }[]>`select status from scripts where workspace_id = ${ws.id} and content_id = ${contentId} order by version`).map((r) => r.status);
    const contentStatus = async (ws: WorkspaceContext, contentId: string) => (await ws.sql<{ status: string }[]>`select status from content where id = ${contentId}`)[0]!.status;

    it("approving makes the version the approved script and the piece ready to film", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const pkg = await packageFor(ws);
      await saveScript(ws, AGENT, { contentId, package: pkg });
      const v2 = await saveScript(ws, AGENT, { contentId, package: pkg });
      await decide(ws, v2.approvalRef!, "approved", "user:studio");
      expect(await scriptStatuses(ws, contentId)).toEqual(["superseded", "approved"]);
      expect(await contentStatus(ws, contentId)).toBe("scripted");
      const runs = await ws.sql`select 1 from agent_runs where workspace_id = ${ws.id}`;
      expect(runs).toHaveLength(0);
    });

    it("a writer run paused on the approval finishes on approve and resumes (no second writer) on changes", async () => {
      const ws = await makeWorkspace(sql);
      const pause = async () => {
        const [run] = await ws.sql<{ id: string }[]>`insert into agent_runs (workspace_id, agent, job_id, status) values (${ws.id}, 'copywriter', 'scripting.write-script', 'waiting_approval') returning id`;
        return run!.id;
      };
      const contentId = await makeContent(ws);
      const pkg = await packageFor(ws);
      const runA = await pause();
      const a = await saveScript(ws, AGENT, { contentId, package: pkg, runId: runA });
      await decide(ws, a.approvalRef!, "approved", "user:studio");
      const [ra] = await ws.sql<{ status: string }[]>`select status from agent_runs where id = ${runA}`;
      expect(ra!.status).toBe("succeeded");

      const other = await makeContent(ws, { title: "Second piece" });
      const runB = await pause();
      const b = await saveScript(ws, AGENT, { contentId: other, package: await packageFor(ws), runId: runB });
      await decide(ws, b.approvalRef!, "revised", "user:studio", "Shorter");
      const runs = await ws.sql<{ id: string; status: string }[]>`select id, status from agent_runs where workspace_id = ${ws.id} order by created_at`;
      expect(runs).toEqual([{ id: runA, status: "succeeded" }, { id: runB, status: "waiting_approval" }]);
    });

    it("rejecting sends the piece back to the ideas list", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const res = await saveScript(ws, AGENT, { contentId, package: await packageFor(ws) });
      expect(await contentStatus(ws, contentId)).toBe("scripted");
      await decide(ws, res.approvalRef!, "rejected", "user:telegram", "Off-brand");
      expect(await scriptStatuses(ws, contentId)).toEqual(["rejected"]);
      expect(await contentStatus(ws, contentId)).toBe("idea");
    });

    it("a person's request for changes queues the next version once, with the notes; bookkeeping never does", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const pkg = await packageFor(ws);
      const v1 = await saveScript(ws, AGENT, { contentId, package: pkg });
      // A newer version marks v1's approval "revised" by the system: no rewrite.
      const v2 = await saveScript(ws, AGENT, { contentId, package: pkg });
      expect(await ws.sql`select 1 from agent_runs where workspace_id = ${ws.id}`).toHaveLength(0);
      const [old] = await ws.sql<{ status: string; decided_by: string }[]>`select status, decided_by from approvals where ref = ${v1.approvalRef!} and workspace_id = ${ws.id}`;
      expect(old).toMatchObject({ status: "revised", decided_by: "system" });

      await decide(ws, v2.approvalRef!, "revised", "user:studio", "Open on the receipt, not the question");
      const runs = await ws.sql<{ job_id: string; agent: string; input: Record<string, unknown>; dedupe_key: string; created_by: string }[]>`
        select job_id, agent, input, dedupe_key, created_by from agent_runs where workspace_id = ${ws.id}`;
      expect(runs).toEqual([{
        job_id: "scripting.write-script",
        agent: "copywriter",
        input: { contentId, revise: { approvalRef: v2.approvalRef, fromVersion: 2, notes: "Open on the receipt, not the question" } },
        dedupe_key: `write-script:${contentId}:revise:${v2.approvalRef}`,
        created_by: "user:studio",
      }]);
      const { writeScriptInput } = await import("../src/index.ts");
      expect(writeScriptInput.parse(runs[0]!.input).revise?.notes).toBe("Open on the receipt, not the question");
      const [ev] = await ws.sql<{ message: string }[]>`select message from agent_events where workspace_id = ${ws.id} and kind = 'handoff'`;
      expect(ev!.message).toBe("Writing version 3 of “Why remodel budgets break early” from your notes");

      // The brief the Copywriter reads next carries the previous version and the note.
      const brief = await tool("scripting_get_content_brief")(ws, { contentId });
      expect(brief.latestScript).toMatchObject({ version: 2, reviewNote: "Open on the receipt, not the question" });
      expect(String((brief.latestScript as { body: string }).body)).toBe(pkg.body);
    });

    it("on autopilot a passing script is approved without asking", async () => {
      const ws = await makeWorkspace(sql);
      (ws.config.agents as Record<string, unknown>).copywriter = { ...(ws.config.agents.copywriter ?? {}), autonomy: "autopilot" };
      const contentId = await makeContent(ws);
      const pkg = await packageFor(ws);
      const res = await saveScript(ws, AGENT, { contentId, package: pkg });
      expect(res).toMatchObject({ ok: true, approvalRef: null });
      expect(res.message).toContain("ready to film");
      expect(await scriptStatuses(ws, contentId)).toEqual(["approved"]);
      const again = await saveScript(ws, AGENT, { contentId, package: pkg });
      expect(again.approvalRef).toBeNull();
      expect(await scriptStatuses(ws, contentId)).toEqual(["superseded", "approved"]);
      expect(await ws.sql`select 1 from approvals where workspace_id = ${ws.id}`).toHaveLength(0);
    });
  });

  describe("write-script loop with a stubbed model", () => {
    it("puts the owner's change request in the prompt", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const good = await packageFor(ws);
      const prompts: string[] = [];
      const progress: string[] = [];
      const out = await runWriteScript({
        ws, actor: AGENT, contentId, rng: seededRandom(3),
        revise: { approvalRef: "ap-9", fromVersion: 1, notes: "Shorter hook" },
        model: async ({ prompt }) => (prompts.push(prompt), good),
        progress: (m) => void progress.push(m),
      });
      expect(out.ok).toBe(true);
      expect(prompts[0]).toContain("The owner reviewed version 1 (ap-9) and asked for changes:");
      expect(prompts[0]).toContain('"Shorter hook"');
      expect(progress[0]).toBe('Revising "Why remodel budgets break early" from your notes');
    });

    it("revises with the exact fixes, then saves and requests approval", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const good = await packageFor(ws);
      const bad = { ...withBeat("hook", "Let me explain why your remodel budget breaks."), hookSource: good.hookSource };
      const prompts: string[] = [];
      const model: ScriptModel = async ({ prompt, attempt }) => {
        prompts.push(prompt);
        return attempt === 0 ? JSON.stringify(bad) : `Here it is:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
      };
      const progress: string[] = [];
      const out = await runWriteScript({ ws, actor: AGENT, contentId, model, rng: seededRandom(1), progress: (m) => void progress.push(m) });
      expect(out).toMatchObject({ ok: true, version: 1 });
      expect(out.attempts).toEqual([{ attempt: 0, ok: false, errors: 1 }, { attempt: 1, ok: true, errors: 0 }]);
      expect(out.approvalRef).toMatch(/^ap-/);
      expect(prompts[0]).toContain("brand/voice.md");
      expect(prompts[0]).not.toContain("Examplebrand");
      expect(prompts[1]).toContain('opens with "Let me explain"');
      expect(progress.at(-1)).toContain("waiting for review");
    });

    it("after two failed revisions it saves the draft for a person and asks no approval", async () => {
      const ws = await makeWorkspace(sql);
      const contentId = await makeContent(ws);
      const good = await packageFor(ws);
      const bad = { ...withBeat("hook", "Let me explain why your remodel budget breaks."), hookSource: good.hookSource };
      let calls = 0;
      const out = await runWriteScript({ ws, actor: AGENT, contentId, model: async () => (calls++, bad), rng: seededRandom(2) });
      expect(calls).toBe(3);
      expect(out).toMatchObject({ ok: false, version: 1, approvalRef: null });
      expect(out.summary).toContain("needs a person");
      const [row] = await ws.sql<{ status: string; validator_report: { ok: boolean } }[]>`select status, validator_report from scripts where content_id = ${contentId}`;
      expect(row).toMatchObject({ status: "draft", validator_report: { ok: false } });
    });

    it("honours maxRevisions from module settings", async () => {
      const ws = await makeWorkspace(sql, { modules: { scripting: { settings: { maxRevisions: 0 } } } });
      const contentId = await makeContent(ws);
      let calls = 0;
      await runWriteScript({ ws, actor: AGENT, contentId, model: async () => (calls++, "nope") });
      expect(calls).toBe(1);
    });
  });

  describe("hook banks", () => {
    it("own bank takes openers at 3x the median or better", async () => {
      const ws = await makeWorkspace(sql);
      const views = [1000, 1200, 900, 1100, 5000];
      for (const [i, v] of views.entries()) {
        const contentId = await makeContent(ws, { title: `Post ${i}` });
        await ws.sql`insert into scripts (workspace_id, content_id, version, body, hook_text, hook_source, status)
                     values (${ws.id}, ${contentId}, 1, 'body', ${`Opener number ${i} for a remodel.`}, ${ws.sql.json({ pattern: "contrarian" })}, 'approved')`;
        const [post] = await ws.sql<{ id: string }[]>`insert into posts (workspace_id, content_id, platform, provider, status, idempotency_key)
                     values (${ws.id}, ${contentId}, 'instagram', 'zernio', 'published', ${`k-${i}`}) returning id`;
        await ws.sql`insert into post_metrics (workspace_id, post_id, views) values (${ws.id}, ${post!.id}, ${v})`;
      }
      const first = await harvestOwnHooks(ws);
      expect(first).toMatchObject({ added: 1, updated: 0, median: 1100 });
      const again = await harvestOwnHooks(ws);
      expect(again).toMatchObject({ added: 0, updated: 1 });
      const hooks = await ws.sql<{ text: string; pattern: string; origin: string }[]>`select text, pattern, origin from hooks where workspace_id = ${ws.id}`;
      expect(hooks).toEqual([{ text: "Opener number 4 for a remodel.", pattern: "contrarian", origin: "own" }]);
    });

    it("competitor bank is capped and decays; the classifier output is validated before it's written", async () => {
      const ws = await makeWorkspace(sql, { modules: { scripting: { settings: { competitorBankCap: 2, competitorHalfLifeDays: 30 } } } });
      const posts = [
        { id: "p1", hook: "Stop asking contractors for a ballpark price.", x: 10, days: 90 },
        { id: "p2", hook: "Three things to check before you sign.", x: 4, days: 1 },
        { id: "p3", hook: "Kitchens are fun to plan with friends.", x: 5, days: 2 },
      ];
      for (const p of posts) {
        await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, x_score, is_outlier, spoken_hook)
                     values (${ws.id}, 'instagram', ${p.id}, 'creator_a', ${`https://example.com/${p.id}`}, ${new Date(NOW.getTime() - p.days * 86_400_000)}, ${p.x}, true, ${p.hook})`;
      }
      const res = await harvestCompetitorHooks(ws);
      expect(res).toMatchObject({ added: 3, active: 2, retired: 1 });
      const rows = await ws.sql<{ id: string; text: string; pattern: string; status: string; score: string }[]>`
        select id, text, pattern, status, score from hooks where workspace_id = ${ws.id} order by score desc`;
      // p1: 10 * 0.5^(90/30) = 1.25 → lowest, retired. p3 4.89, p2 3.91.
      expect(rows.map((r) => [r.text.slice(0, 12), r.status])).toEqual([
        ["Kitchens are", "active"],
        ["Three things", "active"],
        ["Stop asking ", "retired"],
      ]);
      expect(rows.find((r) => r.text.startsWith("Kitchens"))!.pattern).toBe("unclassified");
      expect(rows.find((r) => r.text.startsWith("Three"))!.pattern).toBe("list-instant-reveal");
      expect((await harvestCompetitorHooks(ws)).added).toBe(0);

      const unclassified = rows.find((r) => r.pattern === "unclassified")!;
      const applied = await applyClassifications(
        ws,
        { items: [{ id: unclassified.id, pattern: "pov-identity", abstract: "[Activity] is better with [people] when [condition]." }, { id: "not-sent", pattern: "myth-bust", abstract: "[Belief] is a myth." }] },
        [{ id: unclassified.id, text: unclassified.text }],
      );
      expect(applied).toMatchObject({ applied: 1, rejected: 1 });
      const [h] = await ws.sql<{ pattern: string; abstract: string }[]>`select pattern, abstract from hooks where id = ${unclassified.id}`;
      expect(h).toEqual({ pattern: "pov-identity", abstract: "[Activity] is better with [people] when [condition]." });
    });
  });
});

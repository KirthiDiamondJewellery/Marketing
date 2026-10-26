import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError, type Crm, type Lead } from "@attentionos/core";
import { decideApproval } from "@attentionos/db";
import { schedulePost } from "@attentionos/module-publishing";
import {
  activatePending, applyTriageVerdicts, createKeywordAutomation, draftCommentReplies, ingestInboxEvent, registerLeadMagnet, sendApproved, sendReply, triageInbox,
} from "../src/index.ts";
import { jobs } from "../src/jobs/index.ts";
import { NOW, seedContent, testDb, testWorkspace, type TestDb, type TestWs } from "../../publishing/test/helpers.ts";

let db: TestDb;
beforeAll(async () => { db = await testDb("community"); });
afterAll(async () => { await db?.drop(); });

const MON_8 = "2026-10-19T12:00:00.000Z";
const ACK = { acknowledgements: { automatedDmRisk: true } };
const GUIDE = "# Make a notebook last\n\nYou commented STITCH.\n\n## What's inside\n- a\n- b\n- c\n- d\n\n## The steps\nDo it.\n<!--CTA-->\n\n## What this just showed you\nNext.";

async function guideFor(ws: TestWs, contentId: string) {
  const r = await registerLeadMagnet(ws, { contentId, title: "The notebook care guide", kind: "page", bodyMd: GUIDE });
  if (!r.ok) throw new Error(r.errors.join(" "));
  return r.leadMagnet;
}

describe("lead magnets", () => {
  it("registers one guide per keyword with a tracked link keyed on the post number", async () => {
    const ws = await testWorkspace(db.sql);
    const { contentId } = await seedContent(ws);
    const lm = await guideFor(ws, contentId);
    expect(lm.url).toBe("https://examplebrand.example/guide/make-a-notebook-last");
    expect(lm.tracked_url).toBe("https://examplebrand.example/guide/make-a-notebook-last?utm_source=instagram&utm_medium=social&utm_campaign=organic&utm_content=stitch_1");
    expect(lm.email_gate).toBe(true);
    const again = await registerLeadMagnet(ws, { contentId, title: "Notebook care, v2", kind: "doc", url: "https://docs.example/notebook" });
    expect(again.ok && again.created).toBe(false);
    const n = (await ws.sql<{ n: number }[]>`select count(*)::int as n from lead_magnets where workspace_id = ${ws.id}`)[0]!.n;
    expect(n).toBe(1);
    const bad = await registerLeadMagnet(ws, { contentId, title: "x", kind: "page", bodyMd: "no format" });
    expect(bad.ok).toBe(false);
  });

  it("reserves a keyword through the ledger rules, with suggestions when it collides", async () => {
    const ws = await testWorkspace(db.sql);
    await seedContent(ws, { keyword: "stitch" });
    const second = await seedContent(ws, { keyword: null, title: "Paper grain explained" });
    const collide = await registerLeadMagnet(ws, { contentId: second.contentId, keyword: "stitches", title: "Grain guide", kind: "page" });
    expect(collide.ok).toBe(false);
    if (!collide.ok) expect(collide.errors.join(" ")).toMatch(/overlaps the used keyword "stitch"/);
    const ok = await registerLeadMagnet(ws, { contentId: second.contentId, keyword: "grain", title: "Grain guide", kind: "page" });
    expect(ok.ok).toBe(true);
    const [k] = await ws.sql<{ word: string; status: string }[]>`select word::text as word, status from keywords where workspace_id = ${ws.id} and content_id = ${second.contentId}`;
    expect(k).toEqual({ word: "grain", status: "reserved" });
  });
});

describe("keyword → DM automation", () => {
  it("requires the automated-DM acknowledgement", async () => {
    const ws = await testWorkspace(db.sql);
    const { contentId } = await seedContent(ws);
    const r = await createKeywordAutomation(ws, { contentId });
    expect(r.outcome).toBe("needs_acknowledgement");
    expect(r.message).toMatch(/one private reply per comment/);
  });

  it("needs the guide first, then waits for approval, then for the post; goes live scoped to the post with the tracked link", async () => {
    const ws = await testWorkspace(db.sql, { config: { ...ACK, agents: { publisher: { autonomy: "autopilot" } } } });
    const { contentId } = await seedContent(ws);
    expect((await createKeywordAutomation(ws, { contentId })).outcome).toBe("invalid");
    const lm = await guideFor(ws, contentId);

    const first = await createKeywordAutomation(ws, { contentId, dmText: "Here's {title}. Tap below." });
    expect(first.outcome).toBe("awaiting_approval");
    await decideApproval(ws.sql, ws.id, { refOrId: first.approvalRef!, decision: "approved", actor: "user:test" });
    expect((await activatePending(ws)).waiting).toBe(1); // no Instagram post yet

    const post = await schedulePost(ws, { contentId, platform: "instagram", scheduledAt: MON_8, dryRun: false, mode: "auto" });
    expect(post.outcome).toBe("scheduled");
    expect((await activatePending(ws)).active).toBe(1);
    const [auto] = ws.fake.automations;
    expect(auto).toMatchObject({
      accountId: "acct-ig", platform: "instagram", providerPostId: "pp-1", keyword: "stitch", matchMode: "exact_word",
      dmText: "Here's The notebook care guide. Tap below.", buttons: [{ label: "Get the guide", url: lm.tracked_url }],
    });
    expect(auto!.requireFollow).toBeUndefined();
    const [k] = await ws.sql<{ status: string }[]>`select status from keywords where workspace_id = ${ws.id} and word = 'stitch'`;
    expect(k!.status).toBe("active");
    expect((await createKeywordAutomation(ws, { contentId })).outcome).toBe("already_active");
  });

  it("refuses links in the DM text and follow gates on Facebook; maps a DM-tool conflict to a plain fix", async () => {
    const ws = await testWorkspace(db.sql, { config: { ...ACK, agents: { community: { autonomy: "autopilot" }, publisher: { autonomy: "autopilot" } } } });
    const { contentId } = await seedContent(ws);
    await guideFor(ws, contentId);
    const link = await createKeywordAutomation(ws, { contentId, dmText: "Grab it at https://examplebrand.example" });
    expect(link.outcome).toBe("invalid");
    expect((await createKeywordAutomation(ws, { contentId, platform: "facebook", requireFollow: true })).outcome).toBe("invalid");

    await schedulePost(ws, { contentId, platform: "instagram", scheduledAt: MON_8, dryRun: false, mode: "auto" });
    ws.fake.failAutomation = new ProviderError("fakepub", "conflict", "Another DM tool is connected to this Instagram account");
    const r = await createKeywordAutomation(ws, { contentId, requireFollow: true });
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/follow gate off/);
    const [a] = await ws.sql<{ status: string }[]>`select status from dm_automations where workspace_id = ${ws.id}`;
    expect(a!.status).toBe("failed");
  });
});

describe("DM triage", () => {
  function inboxFixture(ws: TestWs) {
    ws.fake.conversations = [
      { id: "acct-ig:c1", lastMessageAt: "2026-10-14T10:00:00Z", participant: "demo_reader_1" },
      { id: "acct-ig:c2", lastMessageAt: "2026-10-14T10:05:00Z", participant: "promo.bot" },
      { id: "acct-ig:c3", lastMessageAt: "2026-10-14T10:10:00Z", participant: "demo_reader_3" },
    ];
    const m = (id: string, conv: string, direction: "in" | "out", text: string, at: string) => ({ id, conversationId: conv, platform: "instagram" as const, from: { id: "u" }, text, at, direction });
    ws.fake.messages = {
      "acct-ig:c1": [m("1", "acct-ig:c1", "in", "Do you run the bookbinding workshop for teams? How do we book?", "2026-10-14T10:00:00Z")],
      "acct-ig:c2": [m("2", "acct-ig:c2", "in", "Promote your page with real followers, cheap!", "2026-10-14T10:05:00Z")],
      "acct-ig:c3": [m("3", "acct-ig:c3", "in", "STITCH", "2026-10-14T10:10:00Z")],
    };
  }

  it("prefilters with rules, queues only real conversations for the tool-less classifier, and caches verdicts", async () => {
    const ws = await testWorkspace(db.sql);
    await seedContent(ws);
    await ws.sql`insert into social_accounts (workspace_id, provider, provider_account_id, platform, handle) values (${ws.id}, 'fakepub', 'acct-ig', 'instagram', 'examplebrand.studio')`;
    inboxFixture(ws);
    const s = await triageInbox(ws);
    expect(s).toMatchObject({ threads: 3, spam: 1, auto: 1, needsReview: 1, queuedForAi: 1 });
    const [run] = await ws.sql<{ job_id: string; input: { itemIds: string[] }; status: string }[]>`select job_id, input, status from agent_runs where workspace_id = ${ws.id}`;
    expect(run).toMatchObject({ job_id: "community.dm-classify", status: "queued" });

    // The tool-less job's output is persisted through onOutput.
    const classify = jobs.find((j) => j.id === "community.dm-classify")!;
    expect(classify.kind === "llm" && classify.toolless && classify.allowedTools.length === 0).toBe(true);
    const itemId = run!.input.itemIds[0]!;
    const ctx = { ws, input: { itemIds: [itemId] }, actor: "agent:community" as const, runId: "00000000-0000-4000-8000-000000000001", log: ws.log, signal: new AbortController().signal, progress: async () => {} };
    if (classify.kind !== "llm") throw new Error("kind");
    expect(await classify.prompt(ctx as never)).toContain("bookbinding workshop for teams");
    await classify.onOutput!(ctx as never, { verdicts: [{ id: itemId, keep: true, intent: "booking", temperature: "hot", sensitive: false, whatTheyWant: "Book a team workshop", draftReply: "Yes we do! Want me to send dates?" }] });

    const [item] = await ws.sql<{ status: string; temperature: string; draft_reply: string }[]>`select status, temperature, draft_reply from triage_items where id = ${itemId}`;
    expect(item).toEqual({ status: "drafted", temperature: "hot", draft_reply: "Yes we do! Want me to send dates?" });
    const [contact] = await ws.sql<{ handle: string; temperature: string }[]>`select handle, temperature from contacts where workspace_id = ${ws.id}`;
    expect(contact).toEqual({ handle: "demo_reader_1", temperature: "hot" });
    const [hot] = await ws.sql<{ body: { text: string } }[]>`select body from messages where workspace_id = ${ws.id} and dedupe_key like 'hot-leads:%'`;
    expect(hot!.body.text).toContain("@demo_reader_1");

    // Same conversation, nothing new: cached, not re-queued.
    const again = await triageInbox(ws);
    expect(again).toMatchObject({ needsReview: 0, cached: 1, queuedForAi: 0 });
    // A new message reopens it.
    ws.fake.messages["acct-ig:c1"]!.push({ id: "4", conversationId: "acct-ig:c1", platform: "instagram", from: { id: "u" }, text: "Also, do you ship notebooks abroad?", at: "2026-10-14T11:00:00Z", direction: "in" });
    expect((await triageInbox(ws)).queuedForAi).toBe(1);
  });

  it("rejects unusable drafts but keeps the verdict", async () => {
    const ws = await testWorkspace(db.sql);
    const [item] = await ws.sql<{ id: string }[]>`
      insert into triage_items (workspace_id, kind, provider_item_id, conversation_id, platform, from_handle, text, prefilter, status, received_at)
      values (${ws.id}, 'dm', 'acct-ig:c9', 'acct-ig:c9', 'instagram', 'demo_reader_2', 'how much?', 'needs_review', 'new', ${NOW}) returning id`;
    const r = await applyTriageVerdicts(ws, { verdicts: [{ id: item!.id, keep: true, intent: "pricing", temperature: "warm", whatTheyWant: "Price", draftReply: "It's $95 per seat" }] });
    expect(r).toMatchObject({ applied: 1, drafts: 0, rejectedDrafts: 1 });
    const [row] = await ws.sql<{ status: string; draft_reply: string | null }[]>`select status, draft_reply from triage_items where id = ${item!.id}`;
    expect(row).toEqual({ status: "new", draft_reply: null });
    expect((await applyTriageVerdicts(ws, "garbage")).errors[0]).toMatch(/no JSON/);
  });
});

describe("sending replies (approval-checked)", () => {
  let seq = 0;
  async function drafted(ws: TestWs, temperature = "warm") {
    const conv = `acct-ig:c${++seq === 1 ? 1 : seq + 100}`;
    const [item] = await ws.sql<{ id: string }[]>`
      insert into triage_items (workspace_id, kind, provider_item_id, conversation_id, platform, from_handle, text, prefilter, temperature, draft_reply, status, received_at)
      values (${ws.id}, 'dm', ${conv}, ${conv}, 'instagram', 'demo_reader_1', 'Do you run team workshops?', 'needs_review', ${temperature}, 'Yes! Want the dates?', 'drafted', ${NOW}) returning id`;
    return item!.id;
  }

  it("review_all: nothing is sent until a person approves that exact text", async () => {
    const ws = await testWorkspace(db.sql);
    const id = await drafted(ws);
    const r = await sendReply(ws, { itemId: id });
    expect(r.outcome).toBe("awaiting_approval");
    expect(ws.fake.sent).toHaveLength(0);
    await decideApproval(ws.sql, ws.id, { refOrId: r.approvalRef!, decision: "approved", actor: "user:test" });
    // Editing after approval needs a new approval.
    const edited = await sendReply(ws, { itemId: id, text: "Yes! Here are the dates." });
    expect(edited.outcome).toBe("awaiting_approval");
    expect(edited.approvalRef).not.toBe(r.approvalRef);
    await decideApproval(ws.sql, ws.id, { refOrId: edited.approvalRef!, decision: "approved", actor: "user:test" });
    expect(await sendApproved(ws)).toEqual({ sent: 1, failed: 0 });
    expect(ws.fake.sent).toEqual([{ conversationId: "acct-ig:c1", text: "Yes! Here are the dates." }]);
    expect((await sendReply(ws, { itemId: id })).outcome).toBe("sent");
    expect(ws.fake.sent).toHaveLength(1);
  });

  it("review_key holds hot leads; autopilot still needs the automated-DM acknowledgement", async () => {
    const key = await testWorkspace(db.sql, { config: { agents: { community: { autonomy: "review_key" } } } });
    expect((await sendReply(key, { itemId: await drafted(key, "hot") })).outcome).toBe("awaiting_approval");
    const warmId = await drafted(key, "warm");
    expect((await sendReply(key, { itemId: warmId })).outcome).toBe("needs_acknowledgement");

    const auto = await testWorkspace(db.sql, { config: { ...ACK, agents: { community: { autonomy: "autopilot" } } } });
    expect((await sendReply(auto, { itemId: await drafted(auto) })).outcome).toBe("sent");
    expect((await sendReply(auto, { itemId: await drafted(auto), text: "It's $50" })).outcome).toBe("invalid");
  });
});

describe("comment replies and webhook events", () => {
  it("drafts from the rotating bank, never the same reply twice in a row, skipping keyword-only comments", async () => {
    const ws = await testWorkspace(db.sql, { config: { modules: { community: { settings: { replyBank: ["Thank you!", "So glad this helped.", "Happy binding!"] } } }, agents: { publisher: { autonomy: "autopilot" } } } });
    const { contentId } = await seedContent(ws);
    const p = await schedulePost(ws, { contentId, platform: "instagram", dryRun: false, mode: "auto" });
    expect(p.outcome).toBe("published");
    const c = (id: string, text: string) => ({ id, providerPostId: "pp-1", platform: "instagram" as const, from: { id: id, handle: `reader${id}` }, text, at: "2026-10-14T12:30:00Z" });
    ws.fake.comments["pp-1"] = [c("1", "STITCH"), c("2", "This is so useful"), c("3", "Which thread is that?"), c("4", "Love the cover")];
    const s = await draftCommentReplies(ws);
    expect(s).toMatchObject({ posts: 1, comments: 4, drafted: 3 });
    const rows = await ws.sql<{ provider_item_id: string; draft_reply: string | null; status: string }[]>`select provider_item_id, draft_reply, status from triage_items where workspace_id = ${ws.id} and kind = 'comment' order by provider_item_id`;
    expect(rows[0]).toMatchObject({ status: "ignored", draft_reply: null });
    const drafts = rows.slice(1).map((r) => r.draft_reply);
    expect(new Set(drafts).size).toBe(3);
    expect((await draftCommentReplies(ws)).drafted).toBe(0);
    expect(ws.fake.replies).toHaveLength(0);
  });

  it("files webhook DMs into triage and saves captured leads", async () => {
    const ws = await testWorkspace(db.sql);
    ws.fake.messages["acct-ig:c7"] = [];
    const row = await ingestInboxEvent(ws, { type: "message.received", conversationId: "acct-ig:c7", message: { id: "m7", conversationId: "acct-ig:c7", platform: "instagram", from: { id: "u7", handle: "demo_reader_4" }, text: "Can I book a private lesson?", at: "2026-10-14T13:00:00Z", direction: "in" } });
    expect(row).toMatchObject({ prefilter: "needs_review", status: "new", from_handle: "demo_reader_4" });

    const leadJob = jobs.find((j) => j.id === "community.lead-captured")!;
    if (leadJob.kind !== "native") throw new Error("kind");
    const out = await leadJob.run({ ws, input: leadJob.input.parse({ email: "Reader@Examplebrand.example", keyword: "stitch", isFollower: true }), actor: "system", runId: "r", log: ws.log, signal: new AbortController().signal, progress: async () => {} } as never);
    expect(out).toMatchObject({ crm: "lite", created: true });
    const [contact] = await ws.sql<{ email: string; keyword: string; temperature: string }[]>`select email::text as email, keyword, temperature from contacts where workspace_id = ${ws.id}`;
    expect(contact).toEqual({ email: "reader@examplebrand.example", keyword: "stitch", temperature: "warm" });
  });

  it("hands leads to the configured CRM and keeps them when the CRM fails", async () => {
    const got: Lead[] = [];
    const crm: Crm = { id: "crm-fake", health: async () => ({ ok: true, detail: "" }), upsertLead: async (l) => { got.push(l); if (l.email?.startsWith("fail")) throw new ProviderError("crm-fake", "upstream", "down"); return { id: "crm-1" }; } };
    const ws = await testWorkspace(db.sql, { providers: { crm } });
    const leadJob = jobs.find((j) => j.id === "community.lead-captured")!;
    if (leadJob.kind !== "native") throw new Error("kind");
    const run = (email: string) => leadJob.run({ ws, input: leadJob.input.parse({ email }), actor: "system", runId: "r", log: ws.log, signal: new AbortController().signal, progress: async () => {} } as never);
    expect(await run("ok@examplebrand.example")).toMatchObject({ crm: "sent", crmId: "crm-1" });
    expect(await run("fail@examplebrand.example")).toMatchObject({ crm: "failed" });
    const rows = await ws.sql<{ email: string; crm_external_id: string | null }[]>`select email::text as email, crm_external_id from contacts where workspace_id = ${ws.id} order by email`;
    expect(rows).toEqual([{ email: "fail@examplebrand.example", crm_external_id: null }, { email: "ok@examplebrand.example", crm_external_id: "crm-1" }]);
    expect(got[0]).toMatchObject({ email: "ok@examplebrand.example", source: "keyword DM", temperature: "warm" });
  });
});

import { ProviderError, type Inbox, type InboxComment, type InboxMessage, type Platform, type WorkspaceContext } from "@attentionos/core";
import { enqueueRun } from "@attentionos/db";
import { activity, gate, getSetting, notify, setSetting } from "@attentionos/module-publishing";
import { communitySettings } from "../settings.ts";
import { buildClassifyPrompt, checkDraftReply, extractVerdicts, type ClassifyItem, type Verdict } from "./classify.ts";
import { handoffLead } from "./leads.ts";
import {
  ageTemperature, compileRules, prefilterComment, prefilterThread, type CompiledRules, type PrefilterReason, type Thread,
} from "./prefilter.ts";

/**
 * DM triage: no-AI prefilter → batched tool-less classification with cached verdicts → Hot/Warm/Cold
 * with aging → DRAFT replies only. Sending always goes through `sendReply`, which checks approval.
 */

/** First row of a query that must return one. */
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected a row");
  return row;
}

const AGENT = "community" as const;
export const CLASSIFY_JOB = "community.dm-classify";

export type TriageRow = {
  id: string;
  kind: "dm" | "comment";
  provider_item_id: string;
  conversation_id: string | null;
  provider_post_id: string | null;
  platform: Platform;
  from_handle: string | null;
  text: string;
  prefilter: "spam" | "auto" | "needs_review" | null;
  classification: (Partial<Verdict> & { cacheKey?: string; reason?: PrefilterReason; context?: string[]; waitingSince?: string; at?: string; draftProblems?: string[] }) | null;
  temperature: "hot" | "warm" | "cold" | null;
  draft_reply: string | null;
  status: "new" | "drafted" | "approved" | "sent" | "ignored";
  received_at: Date;
  created_at: Date;
};

const cursorKey = (accountId: string) => `community.triage.cursor:${accountId}`;

async function rulesFor(ws: WorkspaceContext, threads: Thread[] = []): Promise<CompiledRules> {
  const s = communitySettings(ws.config).triage;
  const kw = await ws.sql<{ word: string }[]>`select word::text as word from keywords where workspace_id = ${ws.id} and status in ('reserved', 'active')`;
  const auto = await ws.sql<{ text: string }[]>`select config->'request'->>'dmText' as text from dm_automations where workspace_id = ${ws.id} and status in ('active', 'paused')`;
  return compileRules({
    spamPatterns: s.spamPatterns, automationLinkPatterns: s.automationLinkPatterns, humanTypedLines: s.humanTypedLines,
    keywords: kw.map((k) => k.word), automationTexts: auto.map((a) => a.text).filter(Boolean),
  }, threads);
}

/** Accounts the inbox can read: IG/FB accounts of the inbox's own provider. */
async function inboxAccounts(ws: WorkspaceContext, inbox: Inbox): Promise<{ providerAccountId: string; platform: Platform }[]> {
  let rows: { provider_account_id: string; platform: Platform }[] = await ws.sql<{ provider_account_id: string; platform: Platform }[]>`
    select provider_account_id, platform from social_accounts
     where workspace_id = ${ws.id} and provider = ${inbox.id} and platform in ('instagram', 'facebook') and status = 'connected'`;
  const lister = inbox as Inbox & { listAccounts?: () => Promise<{ providerAccountId: string; platform: Platform; status: string }[]> };
  if (rows.length === 0 && typeof lister.listAccounts === "function") {
    const accounts = await lister.listAccounts();
    rows = accounts.filter((a) => (a.platform === "instagram" || a.platform === "facebook") && a.status === "connected").map((a) => ({ provider_account_id: a.providerAccountId, platform: a.platform }));
  }
  return rows.map((r) => ({ providerAccountId: r.provider_account_id, platform: r.platform }));
}

function cacheKeyFor(conversationId: string, lastAt: string | undefined): string {
  return `${conversationId}|${lastAt ?? ""}`;
}

/** Upserts one DM thread as a triage item. A newer message reopens an item that was already handled. */
async function upsertThreadItem(ws: WorkspaceContext, args: { conversationId: string; platform: Platform; handle?: string; thread: Thread; rules: CompiledRules; now: Date }): Promise<{ row: TriageRow; needsModel: boolean }> {
  const v = prefilterThread(args.thread, args.rules);
  const last = v.lastMessage ?? args.thread.messages.filter((m) => m.direction === "in").at(-1);
  const text = last?.text ?? "";
  const at = last?.at ?? args.now.toISOString();
  const key = cacheKeyFor(args.conversationId, last?.at);
  const context = args.thread.messages.slice(-14).map((m) => `[${m.at.slice(0, 16)}] ${m.direction === "in" ? "THEM" : "OWNER"}: ${m.text.slice(0, 600)}`);
  const status = v.verdict === "needs_review" ? "new" : "ignored";
  const [existing] = await ws.sql<TriageRow[]>`select * from triage_items where workspace_id = ${ws.id} and kind = 'dm' and provider_item_id = ${args.conversationId}`;
  const cached = existing?.classification?.cacheKey === key;
  const classification = cached ? existing!.classification : { cacheKey: key, reason: v.reason, context, ...(v.waitingSince ? { waitingSince: v.waitingSince } : {}) };
  let row: TriageRow;
  if (existing) {
    const reopen = !cached && ["sent", "ignored", "drafted", "approved"].includes(existing.status);
    row = first(await ws.sql<TriageRow[]>`
      update triage_items set text = ${text}, prefilter = ${v.verdict}, from_handle = coalesce(${args.handle ?? null}, from_handle),
             received_at = ${at}, classification = ${ws.sql.json(classification as never)},
             status = ${cached ? existing.status : reopen || existing.status === "new" ? status : existing.status},
             draft_reply = ${cached ? existing.draft_reply : null}
       where workspace_id = ${ws.id} and id = ${existing.id} returning *`);
  } else {
    row = first(await ws.sql<TriageRow[]>`
      insert into triage_items (workspace_id, kind, provider_item_id, conversation_id, platform, from_handle, text, prefilter, classification, status, received_at)
      values (${ws.id}, 'dm', ${args.conversationId}, ${args.conversationId}, ${args.platform}, ${args.handle ?? null}, ${text}, ${v.verdict},
              ${ws.sql.json(classification as never)}, ${status}, ${at})
      returning *`);
  }
  const needsModel = v.verdict === "needs_review" && !(cached && existing?.classification?.temperature);
  return { row, needsModel };
}

export type TriageSummary = { threads: number; spam: number; auto: number; needsReview: number; cached: number; queuedForAi: number; aged: number; batches: string[] };

/** `community.dm-triage`: fetch new conversations, prefilter, reuse cached verdicts, queue the rest for the classifier. */
export async function triageInbox(ws: WorkspaceContext, opts: { runId?: string | null; enqueue?: boolean } = {}): Promise<TriageSummary> {
  const inbox = ws.providers.inbox;
  const summary: TriageSummary = { threads: 0, spam: 0, auto: 0, needsReview: 0, cached: 0, queuedForAi: 0, aged: 0, batches: [] };
  const s = communitySettings(ws.config).triage;
  const now = ws.now();
  if (inbox) {
    for (const acct of await inboxAccounts(ws, inbox)) {
      const since = (await getSetting<string>(ws, cursorKey(acct.providerAccountId))) ?? new Date(now.getTime() - s.lookbackHours * 3_600_000).toISOString();
      const convs = await inbox.listConversations(acct.providerAccountId, { since, limit: 100 });
      const threads: { conv: (typeof convs)[number]; thread: Thread }[] = [];
      for (const conv of convs) {
        const msgs: InboxMessage[] = await inbox.listMessages(conv.id, { limit: 25 });
        threads.push({ conv, thread: { id: conv.id, handle: conv.participant, messages: msgs.map((m) => ({ id: m.id, direction: m.direction, text: m.text, at: m.at })) } });
      }
      const rules = await rulesFor(ws, threads.map((t) => t.thread));
      for (const { conv, thread } of threads) {
        const { row, needsModel } = await upsertThreadItem(ws, { conversationId: conv.id, platform: acct.platform, handle: conv.participant, thread, rules, now });
        summary.threads++;
        if (row.prefilter === "spam") summary.spam++;
        else if (row.prefilter === "auto") summary.auto++;
        else if (needsModel) summary.needsReview++;
        else summary.cached++;
      }
      const newest = convs.map((c) => c.lastMessageAt).sort().at(-1);
      // Re-read the last hour next time: providers can deliver late.
      if (newest) await setSetting(ws, cursorKey(acct.providerAccountId), new Date(Math.min(Date.parse(newest), now.getTime()) - 3_600_000).toISOString());
    }
  }
  summary.aged = await ageItems(ws);
  if (opts.enqueue !== false) {
    const pending = await itemsNeedingClassification(ws, 500);
    for (let i = 0; i < pending.length; i += s.batchSize) {
      const batch = pending.slice(i, i + s.batchSize).map((r) => r.id);
      const { id, deduped } = await enqueueRun(ws.sql, {
        workspaceId: ws.id, jobId: CLASSIFY_JOB, agent: AGENT, trigger: "handoff", input: { itemIds: batch },
        dedupeKey: `dm-classify:${batch.join(",").slice(0, 180)}:${batch.length}`, ...(opts.runId ? { parentRunId: opts.runId } : {}),
      });
      if (!deduped) summary.batches.push(id);
      summary.queuedForAi += batch.length;
    }
  }
  return summary;
}

/** Items the prefilter kept whose current version has no verdict yet. */
export async function itemsNeedingClassification(ws: WorkspaceContext, limit = 50): Promise<TriageRow[]> {
  return ws.sql<TriageRow[]>`
    select * from triage_items
     where workspace_id = ${ws.id} and kind = 'dm' and prefilter = 'needs_review' and status = 'new'
       and (classification is null or classification->>'temperature' is null)
     order by received_at desc limit ${limit}`;
}

/** Input for the tool-less classifier: the latest message plus the last 14 lines of context. */
export async function classifyInput(ws: WorkspaceContext, itemIds: string[]): Promise<{ items: ClassifyItem[]; prompt: string }> {
  const rows = await ws.sql<TriageRow[]>`select * from triage_items where workspace_id = ${ws.id} and id = any(${itemIds})`;
  const now = ws.now().getTime();
  const items = rows.map((r) => ({
    id: r.id, ...(r.from_handle ? { handle: r.from_handle } : {}), platform: r.platform, lastMessage: r.text, context: r.classification?.context ?? [],
    waitingDays: (now - Date.parse(r.classification?.waitingSince ?? new Date(r.received_at).toISOString())) / 86_400_000,
  }));
  let brandContext: Parameters<typeof buildClassifyPrompt>[0]["brandContext"] = {};
  try {
    const kit = ws.brand();
    brandContext = { oneLiner: `${kit.brand.name}: ${kit.brand.oneLiner}`, ...(kit.docs.icp ? { icp: kit.docs.icp } : {}), ...(kit.docs.offers ? { offers: kit.docs.offers } : {}), ...(kit.docs.voice ? { voice: kit.docs.voice } : {}) };
  } catch { /* no brand kit loaded */ }
  return { items, prompt: buildClassifyPrompt({ brandContext, items }) };
}

function allowedHosts(ws: WorkspaceContext): string[] {
  const hosts: string[] = [];
  try {
    const b = ws.brand().brand;
    for (const u of [b.website, b.cta.siteUrl]) if (u) hosts.push(new URL(u).host.replace(/^www\./, ""));
  } catch { /* no brand kit */ }
  return hosts;
}

export type ApplyResult = { applied: number; skipped: number; drafts: number; rejectedDrafts: number; newHot: number; errors: string[] };

/** Validates and stores classifier verdicts (from `community.dm-classify` or the Copilot tool). Idempotent. */
export async function applyTriageVerdicts(ws: WorkspaceContext, raw: unknown): Promise<ApplyResult> {
  const out: ApplyResult = { applied: 0, skipped: 0, drafts: 0, rejectedDrafts: 0, newHot: 0, errors: [] };
  const { batch, error } = extractVerdicts(raw);
  if (!batch) {
    out.errors.push(error ?? "invalid classifier output");
    return out;
  }
  const s = communitySettings(ws.config).triage;
  const hosts = allowedHosts(ws);
  const hot: string[] = [];
  for (const v of batch.verdicts) {
    const [row] = await ws.sql<TriageRow[]>`select * from triage_items where workspace_id = ${ws.id} and id = ${v.id}`;
    if (!row || row.status === "sent") {
      out.skipped++;
      continue;
    }
    let draft: string | null = null;
    const draftProblems: string[] = [];
    if (v.keep && v.draftReply) {
      const chk = checkDraftReply(v.draftReply, { allowedHosts: hosts });
      if (chk.ok) draft = chk.text;
      else {
        draftProblems.push(...chk.reasons);
        out.rejectedDrafts++;
      }
    }
    const waitingSince = new Date(row.classification?.waitingSince ?? row.received_at);
    const temperature = v.keep ? ageTemperature(v.temperature, waitingSince, ws.now(), s) : null;
    const classification = { ...row.classification, ...v, draftReply: undefined, ...(draftProblems.length ? { draftProblems } : {}), at: ws.now().toISOString() };
    const status = !v.keep ? "ignored" : draft ? "drafted" : "new";
    await ws.sql`
      update triage_items set classification = ${ws.sql.json(classification as never)}, temperature = ${temperature},
             draft_reply = ${draft}, status = ${status}
       where workspace_id = ${ws.id} and id = ${row.id}`;
    out.applied++;
    if (draft) out.drafts++;
    if (v.keep && temperature && temperature !== "cold") {
      await handoffLead(ws, {
        ...(row.from_handle ? { handle: row.from_handle } : {}), platform: row.platform, source: `${row.platform} DM`, temperature,
        ...(v.name ? { name: v.name } : {}), notes: [v.whatTheyWant, v.business ? `Business: ${v.business}` : ""].filter(Boolean).join(" · "),
      });
      if (temperature === "hot" && row.temperature !== "hot") hot.push(row.from_handle ? `@${row.from_handle}` : "someone");
    }
  }
  out.newHot = hot.length;
  if (hot.length) {
    await notify(ws, { dedupeKey: `hot-leads:${hot.join(",")}`.slice(0, 200), text: `New hot DM${hot.length === 1 ? "" : "s"}: ${hot.slice(0, 10).join(", ")}. Draft replies are waiting for you.`, priority: "high" });
  }
  await activity(ws, AGENT, `Sorted ${out.applied} DM${out.applied === 1 ? "" : "s"}${out.drafts ? `, drafted ${out.drafts} repl${out.drafts === 1 ? "y" : "ies"}` : ""}${hot.length ? `, ${hot.length} hot` : ""}`);
  return out;
}

/** Hot → Warm → Cold by waiting time; never upwards. */
export async function ageItems(ws: WorkspaceContext): Promise<number> {
  const s = communitySettings(ws.config).triage;
  const rows = await ws.sql<TriageRow[]>`
    select * from triage_items where workspace_id = ${ws.id} and temperature in ('hot', 'warm') and status not in ('sent', 'ignored')`;
  let n = 0;
  for (const r of rows) {
    const t = ageTemperature(r.temperature!, new Date(r.classification?.waitingSince ?? r.received_at), ws.now(), s);
    if (t !== r.temperature) {
      await ws.sql`update triage_items set temperature = ${t} where workspace_id = ${ws.id} and id = ${r.id}`;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Comment reply drafts (rotating bank, API only)
// ---------------------------------------------------------------------------------------------------------------

/** Seeds the reply bank from settings the first time, then returns the least-used active replies first. */
async function replyBank(ws: WorkspaceContext): Promise<{ id: string; text: string }[]> {
  const seed = communitySettings(ws.config).replyBank;
  for (const text of seed) {
    await ws.sql`insert into reply_bank (workspace_id, kind, text) values (${ws.id}, 'comment', ${text}) on conflict do nothing`;
  }
  return ws.sql<{ id: string; text: string }[]>`
    select id, text from reply_bank where workspace_id = ${ws.id} and kind = 'comment' and active
     order by uses, last_used_at nulls first, created_at`;
}

export type CommentSummary = { posts: number; comments: number; drafted: number; skipped: number; noBank: boolean };

/** `community.comment-replies`: drafts public replies for new comments on recent posts. Never sends. */
export async function draftCommentReplies(ws: WorkspaceContext, opts: { days?: number; limitPerPost?: number } = {}): Promise<CommentSummary> {
  const inbox = ws.providers.inbox;
  const summary: CommentSummary = { posts: 0, comments: 0, drafted: 0, skipped: 0, noBank: false };
  if (!inbox) return summary;
  const since = new Date(ws.now().getTime() - (opts.days ?? 7) * 86_400_000);
  const posts = await ws.sql<{ id: string; provider: string; provider_post_id: string | null; platform_post_id: string | null; platform: Platform }[]>`
    select id, provider, provider_post_id, platform_post_id, platform from posts
     where workspace_id = ${ws.id} and status = 'published' and platform in ('instagram', 'facebook') and coalesce(published_at, updated_at) >= ${since}`;
  const rules = await rulesFor(ws);
  const bank = await replyBank(ws);
  if (bank.length === 0) summary.noBank = true;
  let next = 0;
  for (const p of posts) {
    const ref = (p.provider === inbox.id ? p.provider_post_id : null) ?? p.platform_post_id;
    if (!ref) continue;
    summary.posts++;
    let comments: InboxComment[] = [];
    try {
      comments = await inbox.listComments(ref, { limit: opts.limitPerPost ?? 50 });
    } catch (err) {
      if (err instanceof ProviderError && (err.code === "not_found" || err.code === "unsupported")) continue;
      throw err;
    }
    let lastOnPost = "";
    for (const c of comments) {
      summary.comments++;
      const pf = prefilterComment(c.text, rules);
      const reply = pf.verdict === "needs_review" && bank.length ? bank[next % bank.length]! : undefined;
      // Never the same reply twice in a row on one post.
      const chosen = reply && reply.text === lastOnPost && bank.length > 1 ? bank[++next % bank.length]! : reply;
      const inserted = await ws.sql<{ id: string }[]>`
        insert into triage_items (workspace_id, kind, provider_item_id, provider_post_id, platform, from_handle, text, prefilter, draft_reply, status, received_at)
        values (${ws.id}, 'comment', ${c.id}, ${ref}, ${c.platform}, ${c.from.handle ?? null}, ${c.text}, ${pf.verdict},
                ${chosen?.text ?? null}, ${chosen ? "drafted" : pf.verdict === "needs_review" ? "new" : "ignored"}, ${c.at})
        on conflict (workspace_id, kind, provider_item_id) do nothing
        returning id`;
      if (inserted.length === 0) {
        summary.skipped++;
        continue;
      }
      if (chosen) {
        await ws.sql`update reply_bank set uses = uses + 1, last_used_at = now() where workspace_id = ${ws.id} and id = ${chosen.id}`;
        lastOnPost = chosen.text;
        next++;
        summary.drafted++;
      }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------
// Sending (approval-checked)
// ---------------------------------------------------------------------------------------------------------------

export type SendOutcome = { outcome: "sent" | "awaiting_approval" | "rejected" | "invalid" | "needs_acknowledgement" | "failed"; message: string; approvalRef?: string };

/**
 * Sends a drafted (or edited) reply. Always approval-checked: under review_all every reply waits for a person; under
 * review_key hot leads and sensitive conversations wait; autopilot sends drafts only after the automated-DM notice is
 * acknowledged. An approval covers the exact text that was approved: edit it and it needs approving again.
 */
export async function sendReply(ws: WorkspaceContext, args: { itemId: string; text?: string; runId?: string | null }): Promise<SendOutcome> {
  const inbox = ws.providers.inbox;
  if (!inbox) return { outcome: "invalid", message: "No inbox provider is connected." };
  const [item] = await ws.sql<TriageRow[]>`select * from triage_items where workspace_id = ${ws.id} and id = ${args.itemId}`;
  if (!item) return { outcome: "invalid", message: "No such conversation or comment." };
  if (item.status === "sent") return { outcome: "sent", message: "Already sent." };
  const text = (args.text ?? item.draft_reply ?? "").trim();
  const chk = checkDraftReply(text, { allowedHosts: allowedHosts(ws), maxChars: item.kind === "comment" ? 300 : 900 });
  if (!chk.ok) return { outcome: "invalid", message: `The reply can't be sent as written: ${chk.reasons.join("; ")}.` };
  if (args.text && args.text.trim() !== item.draft_reply) {
    await ws.sql`update triage_items set draft_reply = ${chk.text}, status = 'drafted' where workspace_id = ${ws.id} and id = ${item.id}`;
  }
  const who = item.from_handle ? `@${item.from_handle}` : "them";
  const kind = item.kind === "dm" ? "dm_reply" : "comment_reply";
  const isKey = item.temperature === "hot" || item.classification?.sensitive === true;
  const subjectId = item.id;
  // An approval covers one exact text. If the latest approval was for different words, ask again.
  const [prior] = await ws.sql<{ status: string; preview: { text?: string } | null }[]>`
    select status, preview from approvals where workspace_id = ${ws.id} and subject_type = 'triage_items' and subject_id = ${subjectId} and kind = ${kind}
     order by requested_at desc limit 1`;
  if (prior?.status === "approved" && prior.preview?.text !== chk.text) {
    await ws.sql`update approvals set status = 'expired', decision_note = 'reply text changed after approval' where workspace_id = ${ws.id} and subject_type = 'triage_items' and subject_id = ${subjectId} and status = 'approved'`;
  }
  const g = await gate(ws, {
    agent: AGENT, kind, subjectType: "triage_items", subjectId, isKey, runId: args.runId ?? null,
    summary: `Reply to ${who}${item.kind === "comment" ? " on your post" : ""}: "${chk.text.slice(0, 80)}${chk.text.length > 80 ? "…" : ""}"`,
    preview: { text: chk.text, to: who, theirMessage: item.text.slice(0, 300), kind: item.kind },
  });
  if (!g.allowed) {
    if (g.status === "rejected") return { outcome: "rejected", message: `That reply was rejected (${g.ref}). Edit it and try again.`, approvalRef: g.ref };
    await ws.sql`update triage_items set status = 'drafted' where workspace_id = ${ws.id} and id = ${item.id} and status <> 'sent'`;
    return { outcome: "awaiting_approval", message: `Waiting for your approval (${g.ref}) before replying to ${who}.`, approvalRef: g.ref };
  }
  if (g.via === "autonomy" && !ws.config.acknowledgements.automatedDmRisk) {
    return { outcome: "needs_acknowledgement", message: "Sending replies without approval counts as automated DMs. Acknowledge the notice (acknowledgements.automatedDmRisk) or switch the Community agent back to review." };
  }
  try {
    const res = item.kind === "dm" ? await inbox.sendMessage(item.conversation_id ?? item.provider_item_id, chk.text) : await inbox.replyToComment(item.provider_item_id, chk.text);
    await ws.sql`update triage_items set status = 'sent', draft_reply = ${chk.text} where workspace_id = ${ws.id} and id = ${item.id}`;
    await activity(ws, AGENT, `Replied to ${who}`, { itemId: item.id, providerMessageId: res.id }, args.runId);
    return { outcome: "sent", message: `Replied to ${who}.`, ...(g.ref ? { approvalRef: g.ref } : {}) };
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError(inbox.id, "upstream", (err as Error).message);
    return { outcome: "failed", message: e.code === "conflict" ? e.message : `Couldn't send the reply to ${who}: ${e.message}` };
  }
}

/** `community.send-approved`: sends replies whose approval came in since they were drafted. */
export async function sendApproved(ws: WorkspaceContext, runId?: string | null): Promise<{ sent: number; failed: number }> {
  const rows = await ws.sql<{ id: string }[]>`
    select t.id from triage_items t
     where t.workspace_id = ${ws.id} and t.status = 'drafted'
       and exists (select 1 from approvals a where a.workspace_id = t.workspace_id and a.subject_type = 'triage_items' and a.subject_id = t.id and a.status = 'approved')
     limit 50`;
  const out = { sent: 0, failed: 0 };
  for (const r of rows) {
    const res = await sendReply(ws, { itemId: r.id, runId: runId ?? null });
    if (res.outcome === "sent") out.sent++;
    else if (res.outcome === "failed") out.failed++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook ingestion (normalised provider events; structural types so modules never import vendor packages)
// ---------------------------------------------------------------------------------------------------------------

export type InboxEventLike =
  | { type: "message.received"; conversationId: string; message: InboxMessage }
  | { type: "comment.received"; comment: InboxComment }
  | { type: string; [k: string]: unknown };

/** Applies a normalised `message.received` / `comment.received` event: the item is prefiltered and queued for triage. */
export async function ingestInboxEvent(ws: WorkspaceContext, event: InboxEventLike): Promise<TriageRow | undefined> {
  if (event.type === "message.received" && "message" in event && event.message) {
    const e = event as { conversationId: string; message: InboxMessage };
    if (e.message.direction !== "in") return undefined;
    const inbox = ws.providers.inbox;
    let messages: InboxMessage[] = [e.message];
    if (inbox) {
      try {
        messages = await inbox.listMessages(e.conversationId, { limit: 25 });
        if (!messages.some((m) => m.id === e.message.id)) messages.push(e.message);
      } catch {
        messages = [e.message];
      }
    }
    const thread: Thread = { id: e.conversationId, ...(e.message.from.handle ? { handle: e.message.from.handle } : {}), messages: messages.map((m) => ({ id: m.id, direction: m.direction, text: m.text, at: m.at })) };
    const { row } = await upsertThreadItem(ws, { conversationId: e.conversationId, platform: e.message.platform, ...(e.message.from.handle ? { handle: e.message.from.handle } : {}), thread, rules: await rulesFor(ws, [thread]), now: ws.now() });
    return row;
  }
  if (event.type === "comment.received" && "comment" in event && event.comment) {
    const c = event.comment as InboxComment;
    const pf = prefilterComment(c.text, await rulesFor(ws));
    const [row] = await ws.sql<TriageRow[]>`
      insert into triage_items (workspace_id, kind, provider_item_id, provider_post_id, platform, from_handle, text, prefilter, status, received_at)
      values (${ws.id}, 'comment', ${c.id}, ${c.providerPostId}, ${c.platform}, ${c.from.handle ?? null}, ${c.text}, ${pf.verdict}, ${pf.verdict === "needs_review" ? "new" : "ignored"}, ${c.at})
      on conflict (workspace_id, kind, provider_item_id) do update set text = excluded.text
      returning *`;
    return row;
  }
  return undefined;
}

import { ProviderError, type DmAutomationRequest, type Platform, type WorkspaceContext } from "@attentionos/core";
import { checkKeyword, normalizeKeyword, suggestKeywords, type ValidationResult } from "@attentionos/guardrails";
import {
  activity, buildTrackedUrl, buildUtm, buildUtmContent, ensurePostNumber, gate, loadContent, notify, publishingSettings, type PostRow,
} from "@attentionos/module-publishing";
import { AUTOMATED_DM_NOTICE, communitySettings } from "../settings.ts";
import { checkGuide, slugify } from "./guide.ts";

/**
 * Keyword → DM → lead magnet:
 * 1. the piece gets a keyword from the ledger (4–9 letters, never reused, no substring collisions, not in the script);
 * 2. a lead magnet (one guide per keyword) is registered with a tracked link and an email gate;
 * 3. a POST-SCOPED comment-to-DM automation is created through the Inbox provider (case variants added there),
 *    after approval and only once the automated-DM risk notice is acknowledged.
 */

/** First row of a query that must return one. */
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected a row");
  return row;
}

const AGENT = "community" as const;

export type AutomationRow = {
  id: string;
  provider: string;
  provider_automation_id: string | null;
  post_id: string | null;
  keyword_id: string | null;
  lead_magnet_id: string | null;
  status: "draft" | "active" | "paused" | "failed" | "deleted";
  config: { request: Omit<DmAutomationRequest, "accountId" | "providerPostId">; contentId: string; title: string };
  error: string | null;
  created_at: Date;
};

export type LeadMagnetRow = {
  id: string;
  keyword_id: string | null;
  title: string;
  kind: "page" | "doc" | "notion" | "pdf" | "other";
  url: string | null;
  tracked_url: string | null;
  body_md: string | null;
  content_id: string | null;
  slug: string | null;
  email_gate: boolean;
  status: "draft" | "live" | "retired";
  created_at: Date;
};

/** Every keyword ever used or reserved, except this piece's own reservation. */
async function ledgerWords(ws: WorkspaceContext, contentId: string | null): Promise<string[]> {
  const rows = await ws.sql<{ word: string }[]>`
    select word::text as word from keywords
     where workspace_id = ${ws.id} and (${contentId}::uuid is null or content_id is distinct from ${contentId}::uuid)`;
  return rows.map((r) => r.word);
}

export type KeywordResult = { ok: true; keyword: string; keywordId: string } | { ok: false; problems: ValidationResult; suggestions: string[] };

/**
 * Returns the piece's keyword, reserving `word` if it has none yet. Serialised with the scripting module's
 * reservations by the same advisory lock, so two pieces can never take colliding words.
 */
export async function ensureKeyword(ws: WorkspaceContext, contentId: string, word?: string): Promise<KeywordResult> {
  const [existing] = await ws.sql<{ id: string; word: string }[]>`
    select k.id, k.word::text as word from content c join keywords k on k.id = c.keyword_id
     where c.workspace_id = ${ws.id} and c.id = ${contentId}`;
  if (existing && (!word || normalizeKeyword(word) === existing.word.toLowerCase())) return { ok: true, keyword: existing.word.toLowerCase(), keywordId: existing.id };
  if (existing && word) {
    return { ok: false, problems: { ok: false, errors: [{ code: "keyword.already_set", message: `This piece already uses the keyword "${existing.word}".`, fix: "Keep it, or change it in the script first." }], warnings: [] }, suggestions: [] };
  }
  if (!word) return { ok: false, problems: { ok: false, errors: [{ code: "keyword.missing", message: "This piece has no keyword yet.", fix: "Pick one word of 4 to 9 letters tied to the guide." }], warnings: [] }, suggestions: [] };
  const content = await loadContent(ws, contentId);
  const [script] = await ws.sql<{ body: string }[]>`
    select body from scripts where workspace_id = ${ws.id} and content_id = ${contentId} order by version desc limit 1`;
  try {
    return await ws.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`aos:keywords:${ws.id}`}))`;
      const ledger = await ledgerWords(ws, contentId);
      const check = checkKeyword(word, ledger, script?.body ?? "");
      if (!check.ok) return { ok: false as const, problems: check, suggestions: suggestKeywords({ topicText: content?.title ?? "", ledgerWords: ledger, scriptText: script?.body ?? "", count: 5 }) };
      const k = normalizeKeyword(word);
      const [row] = await tx<{ id: string }[]>`insert into keywords (workspace_id, word, status, content_id) values (${ws.id}, ${k}, 'reserved', ${contentId}) returning id`;
      await tx`update content set keyword_id = ${row!.id}, updated_at = now() where workspace_id = ${ws.id} and id = ${contentId}`;
      return { ok: true as const, keyword: k, keywordId: row!.id };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, problems: { ok: false, errors: [{ code: "keyword.taken", message: `"${word}" was just taken by another piece.`, fix: "Pick another word." }], warnings: [] }, suggestions: [] };
    }
    throw err;
  }
}

export type RegisterLeadMagnetInput = {
  contentId?: string;
  keyword?: string;
  title: string;
  kind: LeadMagnetRow["kind"];
  /** Where the guide lives (your site, a Google Doc, Notion). Required unless the body is given for your site to host. */
  url?: string;
  bodyMd?: string;
  emailGate?: boolean;
};

export type RegisterResult =
  | { ok: true; leadMagnet: LeadMagnetRow; created: boolean; warnings: string[]; message: string }
  | { ok: false; errors: string[]; suggestions?: string[] };

/** Registers the one guide for a keyword, with a tracked link: `utm_source=instagram`, `utm_content=<keyword>_<post#>`. */
export async function registerLeadMagnet(ws: WorkspaceContext, input: RegisterLeadMagnetInput): Promise<RegisterResult> {
  let keyword: string | undefined;
  let keywordId: string | undefined;
  if (input.contentId) {
    const k = await ensureKeyword(ws, input.contentId, input.keyword);
    if (!k.ok) return { ok: false, errors: k.problems.errors.map((e) => `${e.message}${e.fix ? ` ${e.fix}` : ""}`), suggestions: k.suggestions };
    keyword = k.keyword;
    keywordId = k.keywordId;
  } else if (input.keyword) {
    const [row] = await ws.sql<{ id: string; word: string }[]>`select id, word::text as word from keywords where workspace_id = ${ws.id} and word = ${normalizeKeyword(input.keyword)}`;
    if (!row) return { ok: false, errors: [`"${input.keyword}" isn't in the keyword ledger. Reserve it on a piece of content first (pass contentId).`] };
    keyword = row.word.toLowerCase();
    keywordId = row.id;
  } else {
    return { ok: false, errors: ["Say which piece (contentId) or keyword this guide belongs to."] };
  }
  const warnings: string[] = [];
  let slug = slugify(input.title);
  if (input.bodyMd) {
    const g = checkGuide(input.bodyMd, { keyword, title: input.title });
    if (!g.ok) return { ok: false, errors: g.errors };
    warnings.push(...g.warnings);
    slug = g.slug;
  }
  let siteUrl: string | undefined;
  try {
    siteUrl = ws.brand().brand.cta.siteUrl;
  } catch {
    siteUrl = undefined;
  }
  const url = input.url ?? (siteUrl ? new URL(`/guide/${slug}`, siteUrl).toString() : undefined);
  if (!url) return { ok: false, errors: ["Give the guide's URL, or set brand.cta.siteUrl so it can be hosted on your site."] };

  const [content] = input.contentId ? await ws.sql<{ id: string; post_number: number | null }[]>`select id, post_number from content where workspace_id = ${ws.id} and id = ${input.contentId}` : [];
  const postNumber = content ? content.post_number ?? (await ensurePostNumber(ws, content.id)) : undefined;
  let prefix = "";
  try {
    prefix = ws.brand().brand.cta.utmContentPrefix;
  } catch { /* no brand kit */ }
  const tracking = publishingSettings(ws.config).tracking;
  const trackedUrl = buildTrackedUrl(url, buildUtm({
    platform: "instagram", medium: tracking.utmMedium, campaign: tracking.utmCampaign,
    content: postNumber ? buildUtmContent({ prefix, keyword, postNumber }) : `${prefix}${keyword}_guide`,
  }));
  const emailGate = input.emailGate ?? communitySettings(ws.config).leadMagnets.emailGate;

  const [existing] = await ws.sql<LeadMagnetRow[]>`select * from lead_magnets where workspace_id = ${ws.id} and keyword_id = ${keywordId}`;
  let row: LeadMagnetRow;
  if (existing) {
    row = first(await ws.sql<LeadMagnetRow[]>`
      update lead_magnets set title = ${input.title}, kind = ${input.kind}, url = ${url}, tracked_url = ${trackedUrl},
             body_md = coalesce(${input.bodyMd ?? null}, body_md), content_id = coalesce(${input.contentId ?? null}, content_id),
             slug = ${slug}, email_gate = ${emailGate}, status = 'live'
       where workspace_id = ${ws.id} and id = ${existing.id} returning *`);
  } else {
    row = first(await ws.sql<LeadMagnetRow[]>`
      insert into lead_magnets (workspace_id, keyword_id, title, kind, url, tracked_url, body_md, content_id, slug, email_gate)
      values (${ws.id}, ${keywordId}, ${input.title}, ${input.kind}, ${url}, ${trackedUrl}, ${input.bodyMd ?? null}, ${input.contentId ?? null}, ${slug}, ${emailGate})
      returning *`);
  }
  if (input.contentId) await ws.sql`update content set lead_magnet_id = ${row.id}, updated_at = now() where workspace_id = ${ws.id} and id = ${input.contentId}`;
  if (!emailGate) warnings.push("The email gate is off for this guide, so readers won't become leads in your CRM.");
  return { ok: true, leadMagnet: row, created: !existing, warnings, message: `${existing ? "Updated" : "Registered"} "${input.title}" for keyword ${keyword.toUpperCase()}.` };
}

/** The post a keyword automation is scoped to, and the id the inbox provider understands. */
async function automationTarget(ws: WorkspaceContext, contentId: string, platform: "instagram" | "facebook"): Promise<{ post?: PostRow; ref?: string; accountId?: string }> {
  const [post] = await ws.sql<PostRow[]>`
    select * from posts where workspace_id = ${ws.id} and content_id = ${contentId} and platform = ${platform}
       and not is_trial and status not in ('cancelled', 'failed')
     order by created_at desc limit 1`;
  if (!post) return {};
  const inbox = ws.providers.inbox;
  // Same vendor publishes and DMs: its own post id works (Zernio even before the post is live). Otherwise use the
  // native platform id, which only exists once the post is live.
  const ref = (inbox && post.provider === inbox.id ? post.provider_post_id : null) ?? post.platform_post_id ?? undefined;
  const [acct] = post.social_account_id
    ? await ws.sql<{ provider: string; provider_account_id: string }[]>`select provider, provider_account_id from social_accounts where workspace_id = ${ws.id} and id = ${post.social_account_id}`
    : [];
  let accountId = acct && inbox && acct.provider === inbox.id ? acct.provider_account_id : undefined;
  if (!accountId && inbox) {
    const [other] = await ws.sql<{ provider_account_id: string }[]>`
      select provider_account_id from social_accounts where workspace_id = ${ws.id} and provider = ${inbox.id} and platform = ${platform} and status = 'connected' limit 1`;
    accountId = other?.provider_account_id;
  }
  return { post, ...(ref ? { ref } : {}), ...(accountId ? { accountId } : {}) };
}

export type CreateAutomationInput = {
  contentId: string;
  platform?: "instagram" | "facebook";
  keyword?: string;
  leadMagnetId?: string;
  dmText?: string;
  buttonLabel?: string;
  requireFollow?: boolean;
  replyComment?: string;
  runId?: string | null;
};

export type AutomationOutcome = {
  outcome: "needs_acknowledgement" | "invalid" | "awaiting_approval" | "rejected" | "waiting_for_post" | "active" | "failed" | "already_active";
  message: string;
  automationId?: string;
  approvalRef?: string;
  problems?: string[];
  suggestions?: string[];
};

export async function createKeywordAutomation(ws: WorkspaceContext, input: CreateAutomationInput): Promise<AutomationOutcome> {
  if (!ws.config.acknowledgements.automatedDmRisk) return { outcome: "needs_acknowledgement", message: AUTOMATED_DM_NOTICE };
  const inbox = ws.providers.inbox;
  if (!inbox) return { outcome: "invalid", message: "No inbox provider is connected (Zernio or Blotato), so keyword DMs can't run." };
  const s = communitySettings(ws.config);
  const platform = input.platform ?? "instagram";
  const content = await loadContent(ws, input.contentId);
  if (!content) return { outcome: "invalid", message: "That piece of content doesn't exist." };

  const k = await ensureKeyword(ws, content.id, input.keyword);
  if (!k.ok) return { outcome: "invalid", message: "The keyword can't be used.", problems: k.problems.errors.map((e) => `${e.message}${e.fix ? ` ${e.fix}` : ""}`), suggestions: k.suggestions };

  const [lm] = await ws.sql<LeadMagnetRow[]>`
    select * from lead_magnets where workspace_id = ${ws.id}
       and ${input.leadMagnetId ? ws.sql`id = ${input.leadMagnetId}` : ws.sql`keyword_id = ${k.keywordId}`}
     limit 1`;
  if (!lm?.tracked_url && !lm?.url) return { outcome: "invalid", message: `Register the guide for ${k.keyword.toUpperCase()} first (community_register_lead_magnet), so the DM has somewhere to send people.` };
  const link = (lm.tracked_url ?? lm.url)!;
  const trackedForPlatform = platform === "facebook" ? link.replace(/utm_source=instagram/, "utm_source=facebook") : link;

  const dmText = (input.dmText ?? s.dm.text).replace(/\{title\}/g, lm.title);
  const problems: string[] = [];
  if ([...dmText].length > 640) problems.push("The DM text is over 640 characters.");
  if (/https?:\/\//i.test(dmText)) problems.push("Don't put a link in the DM text: the button carries it (links in both confuse people and some apps drop the button).");
  const requireFollow = platform === "instagram" && (input.requireFollow ?? s.dm.requireFollow);
  if (platform === "facebook" && input.requireFollow) problems.push("A follow gate only works on Instagram.");
  if (problems.length) return { outcome: "invalid", message: "The automation isn't valid yet.", problems };

  const request: Omit<DmAutomationRequest, "accountId" | "providerPostId"> = {
    platform, keyword: k.keyword, matchMode: s.dm.matchMode, dmText,
    buttons: [{ label: input.buttonLabel ?? s.dm.buttonLabel, url: trackedForPlatform }],
    ...(requireFollow ? { requireFollow: true, ...(s.dm.followGateText ? { followGateText: s.dm.followGateText } : {}) } : {}),
    ...((input.replyComment ?? s.dm.replyComment) ? { replyComment: (input.replyComment ?? s.dm.replyComment)! } : {}),
  };

  const [current] = await ws.sql<AutomationRow[]>`
    select * from dm_automations where workspace_id = ${ws.id} and keyword_id = ${k.keywordId} and status in ('draft', 'active', 'paused')
       and config->>'contentId' = ${content.id} and config->'request'->>'platform' = ${platform}
     order by created_at desc limit 1`;
  if (current?.status === "active") return { outcome: "already_active", message: `The ${k.keyword.toUpperCase()} automation is already live.`, automationId: current.id };
  const config = { request, contentId: content.id, title: content.title };
  let row: AutomationRow;
  if (current) {
    row = first(await ws.sql<AutomationRow[]>`update dm_automations set config = ${ws.sql.json(config as never)}, lead_magnet_id = ${lm.id}, error = null where workspace_id = ${ws.id} and id = ${current.id} returning *`);
  } else {
    row = first(await ws.sql<AutomationRow[]>`
      insert into dm_automations (workspace_id, provider, keyword_id, lead_magnet_id, status, config)
      values (${ws.id}, ${inbox.id}, ${k.keywordId}, ${lm.id}, 'draft', ${ws.sql.json(config as never)}) returning *`);
  }
  return activateAutomation(ws, row.id, input.runId);
}

/** Creates the automation at the provider once it's approved and its post has an id the inbox understands. */
export async function activateAutomation(ws: WorkspaceContext, automationId: string, runId?: string | null): Promise<AutomationOutcome> {
  const [row] = await ws.sql<AutomationRow[]>`select * from dm_automations where workspace_id = ${ws.id} and id = ${automationId}`;
  if (!row) return { outcome: "invalid", message: "No such automation." };
  if (row.status === "active") return { outcome: "already_active", message: "Already live.", automationId };
  if (!ws.config.acknowledgements.automatedDmRisk) return { outcome: "needs_acknowledgement", message: AUTOMATED_DM_NOTICE };
  const inbox = ws.providers.inbox;
  if (!inbox) return { outcome: "invalid", message: "No inbox provider is connected." };
  const { request, contentId, title } = row.config;
  const keyword = request.keyword.toUpperCase();
  const g = await gate(ws, {
    agent: AGENT, kind: "campaign", subjectType: "dm_automations", subjectId: row.id, isKey: false, runId: runId ?? null,
    summary: `Auto-DM the guide to people who comment ${keyword} on "${title}"`,
    preview: { keyword, platform: request.platform, dm: request.dmText, button: request.buttons?.[0] ?? null, followGate: request.requireFollow ?? false },
  });
  if (!g.allowed) {
    return g.status === "rejected"
      ? { outcome: "rejected", message: `The ${keyword} automation was rejected (${g.ref}).`, approvalRef: g.ref, automationId }
      : { outcome: "awaiting_approval", message: `Waiting for your approval (${g.ref}) before the ${keyword} DM goes live.`, approvalRef: g.ref, automationId };
  }
  const target = await automationTarget(ws, contentId, request.platform);
  if (!target.post) return { outcome: "waiting_for_post", message: `Approved. The ${keyword} DM goes live once "${title}" is scheduled on ${request.platform}.`, automationId };
  if (!target.ref || !target.accountId) return { outcome: "waiting_for_post", message: `Approved. The ${keyword} DM goes live as soon as the post is live and has an id.`, automationId };
  if (target.post.id !== row.post_id) await ws.sql`update dm_automations set post_id = ${target.post.id} where workspace_id = ${ws.id} and id = ${row.id}`;
  try {
    const created = await inbox.createDmAutomation({ ...request, accountId: target.accountId, providerPostId: target.ref });
    await ws.sql`update dm_automations set status = 'active', provider_automation_id = ${created.id}, error = null where workspace_id = ${ws.id} and id = ${row.id}`;
    await ws.sql`update keywords set status = 'active' where workspace_id = ${ws.id} and id = ${row.keyword_id} and status = 'reserved'`;
    await activity(ws, AGENT, `Comment ${keyword} on "${title}" now gets the guide by DM`, { automationId: row.id }, runId);
    return { outcome: "active", message: `Live: people who comment ${keyword} on "${title}" get the guide by DM.`, automationId };
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError(inbox.id, "upstream", (err as Error).message);
    if (e.code === "not_found" && /first comment|isn't published yet|not published/i.test(e.message)) {
      await ws.sql`update dm_automations set error = ${e.message} where workspace_id = ${ws.id} and id = ${row.id}`;
      return { outcome: "waiting_for_post", message: e.message, automationId };
    }
    if (e.code === "rate_limited" || e.code === "upstream") {
      await ws.sql`update dm_automations set error = ${e.message} where workspace_id = ${ws.id} and id = ${row.id}`;
      return { outcome: "waiting_for_post", message: `${inbox.id} didn't answer; I'll try again shortly.`, automationId };
    }
    const advice = e.code === "conflict" && request.requireFollow ? " Try again with the follow gate off and the link in the first message." : "";
    await ws.sql`update dm_automations set status = 'failed', error = ${e.message + advice} where workspace_id = ${ws.id} and id = ${row.id}`;
    await notify(ws, { dedupeKey: `automation-failed:${row.id}`, text: `The ${keyword} DM automation couldn't be created: ${e.message}${advice}`, priority: "high" });
    return { outcome: "failed", message: `${e.message}${advice}`, automationId };
  }
}

/** `community.activate-automations`: retries drafts that were waiting for approval or for their post to go live. */
export async function activatePending(ws: WorkspaceContext, runId?: string | null): Promise<{ active: number; waiting: number; failed: number }> {
  const drafts = await ws.sql<{ id: string }[]>`select id from dm_automations where workspace_id = ${ws.id} and status = 'draft' order by created_at limit 50`;
  const out = { active: 0, waiting: 0, failed: 0 };
  for (const d of drafts) {
    const r = await activateAutomation(ws, d.id, runId);
    if (r.outcome === "active") out.active++;
    else if (r.outcome === "failed") out.failed++;
    else out.waiting++;
  }
  return out;
}

export const platformsWithDmAutomations: Platform[] = ["instagram", "facebook"];

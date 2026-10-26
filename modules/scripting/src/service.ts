import { jsonb, agentSettings, BRAND_FILES, ToolError, type Actor, type Sql, type WorkspaceContext } from "@attentionos/core";
import {
  checkKeyword, DEFAULT_CAPTION_PLATFORMS, extractNumbers, IssueCollector, mergeBanned, normalizeKeyword, parseBannedFromVoiceMd,
  scriptPackageSchema, suggestKeywords, validateScript, zodIssuesToIssues,
  type CaptionPlatform, type CitedSource, type ClaimSources, type OwnSource, type ScriptPackage, type ScriptRules, type SpentStat, type ValidationResult,
} from "@attentionos/guardrails";
import {
  consecutiveFailures, getContent, getContentKeyword, latestScript, ledgerWords, nextRef, recentScripts, UUID_RE,
  type ContentRow, type HookRow,
} from "./db.ts";
import { loadRemixSource, ownWinners, remixRulesFor, remixSourceId, remixView, type RemixSource } from "./remix.ts";
import { loadLearnWeights, selectHooks, type HookCandidate, type HookPick } from "./select.ts";
import { scriptingSettings, type ScriptingSettings } from "./settings.ts";
import { getPattern, HOOK_PATTERN_IDS, UNCLASSIFIED } from "./taxonomy.ts";

/** Brand Kit files every scripting skill reads (by path, never inlined). */
export const BRAND_PATHS = {
  voice: `brand/${BRAND_FILES.voice}`,
  icp: `brand/${BRAND_FILES.icp}`,
  offers: `brand/${BRAND_FILES.offers}`,
  pillars: `brand/${BRAND_FILES.pillars}`,
  proofInventory: `brand/${BRAND_FILES.proofInventory}`,
  brand: `brand/${BRAND_FILES.brand}`,
  lessons: `brand/${BRAND_FILES.lessons}`,
} as const;

const KEYWORD_CTAS = new Set(["comment_keyword", "dm_keyword"]);

function requireContent(content: ContentRow | null, id: string): ContentRow {
  if (!content) throw new ToolError(`No content item with id ${id} in this workspace.`, "Use an id from the daily brief or the content list.");
  return content;
}

// ---------------------------------------------------------------------------
// Brief, sources, rules
// ---------------------------------------------------------------------------

/** The proven post this content remixes, if any. */
export async function remixSourceFor(ws: WorkspaceContext, content: ContentRow): Promise<RemixSource | null> {
  const id = remixSourceId(content);
  return id ? loadRemixSource(ws, id) : null;
}

export async function getContentBrief(ws: WorkspaceContext, contentId: string) {
  const content = requireContent(await getContent(ws, contentId), contentId);
  const settings = scriptingSettings(ws);
  const keyword = await getContentKeyword(ws, contentId);
  const latest = await latestScript(ws, contentId);
  const brand = ws.brand().brand;
  const source = await remixSourceFor(ws, content);
  const winners = await ownWinners(ws, 5);
  const [minS, maxS] = lengthWindow(settings, source);
  return {
    /** remix: closely remake the proven post in `remix`. original: no source yet; look for one first. */
    mode: source ? ("remix" as const) : ("original" as const),
    remix: source ? remixView(source) : null,
    /** The owner's best posts against their own normal: how they sound when it works. */
    ownWinners: winners,
    content: {
      id: content.id,
      title: content.title,
      status: content.status,
      kind: content.kind,
      lane: content.lane,
      pillar: content.pillar,
      funnelStage: content.funnel_stage,
      angle: content.angle,
      storyStructure: content.story_structure,
      template: content.template,
      ctaType: content.cta_type ?? brand.cta.primary,
      hookPattern: content.hook_pattern,
      sourceRefs: content.source_refs ?? [],
      brief: content.brief,
      filmBy: content.film_by?.toISOString() ?? null,
    },
    keyword: keyword ? { word: keyword.word, status: keyword.status } : null,
    latestScript: latest
      ? { version: latest.version, status: latest.status, ok: latest.validator_report?.ok ?? null, hookText: latest.hook_text, body: latest.body, reviewNote: await reviewNote(ws, latest.id) }
      : null,
    rules: {
      lengthSeconds: [minS, maxS],
      wordsRange: [Math.ceil((minS * settings.wpm) / 60), Math.floor((maxS * settings.wpm) / 60)],
      ...(source?.blueprint?.words ? { remixWords: source.blueprint.words, note: "A remix runs about as long as its source (remixWords, within wordsRange)." } : {}),
      wpm: settings.wpm,
      hookMaxSeconds: settings.hookMaxSeconds,
      rehookAt: "25 to 40% of the words",
      ctaLine: settings.ctaLines[(content.cta_type ?? brand.cta.primary) as keyof typeof settings.ctaLines] ?? null,
      platforms: captionPlatforms(ws),
    },
    readFirst: [BRAND_PATHS.voice, BRAND_PATHS.icp, BRAND_PATHS.offers, BRAND_PATHS.proofInventory, BRAND_PATHS.pillars, BRAND_PATHS.lessons],
  };
}

/** The owner's latest "request changes" note on this script version, if any. */
async function reviewNote(ws: WorkspaceContext, scriptId: string): Promise<string | null> {
  const rows = await ws.sql<{ note: string | null }[]>`
    select decision_note as note from approvals
     where workspace_id = ${ws.id} and kind = 'script' and subject_type = 'script' and subject_id = ${scriptId}
       and status = 'revised' and decided_by like 'user:%'
     order by decided_at desc nulls last limit 1`;
  return rows[0]?.note ?? null;
}

export function captionPlatforms(ws: WorkspaceContext): CaptionPlatform[] {
  const configured = new Set<string>(ws.config.platforms);
  const out = DEFAULT_CAPTION_PLATFORMS.filter((p) => configured.has(p));
  return out.length > 0 ? out : [...DEFAULT_CAPTION_PLATFORMS];
}

/**
 * The script's length window. A remix keeps its source's length, so a source that ran longer than the default
 * maximum (at the owner's speaking rate) widens it to fit, up to twice the default.
 */
export function lengthWindow(settings: ScriptingSettings, source: RemixSource | null): [number, number] {
  const words = source?.blueprint?.words ?? null;
  const sourceSecs = words ? (words / settings.wpm) * 60 : (source?.blueprint?.durationS ?? source?.durationS ?? null);
  if (!sourceSecs) return [settings.minSeconds, settings.maxSeconds];
  const max = Math.min(settings.maxSeconds * 2, Math.max(settings.maxSeconds, Math.ceil(sourceSecs * 1.15)));
  return [settings.minSeconds, max];
}

/** The owner's own offers and site, citable as offer:<id> or a link on their site (no "they say" needed). */
export function ownSources(ws: WorkspaceContext, ownPost?: { externalPostId: string; url: string } | null): OwnSource[] {
  const b = ws.brand().brand;
  const site = b.website ?? b.cta.siteUrl;
  return [
    ...b.offers.map((o) => ({ id: o.id, title: o.name, ...(o.url ?? site ? { url: o.url ?? site, wholeSite: true } : {}) })),
    ...(site ? [{ id: "site", title: `${b.name} website`, url: site, wholeSite: true }] : []),
    // Remaking one of the owner's own posts: what they said about themselves there is theirs to say again.
    ...(ownPost ? [{ id: "own-post", title: "Your own post this remakes", url: ownPost.url }] : []),
  ];
}

export type ClaimSourcesView = ClaimSources & {
  proofDetail: { id: string; kind: string; title: string; summary: string; clientConsent: boolean; numbers: { value: string; label: string; source: string }[] }[];
};

export async function getClaimSources(ws: WorkspaceContext, contentId: string | null, settings: ScriptingSettings = scriptingSettings(ws)): Promise<ClaimSourcesView> {
  const kit = ws.brand();
  const proofDetail = kit.proofInventory.items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, summary: i.summary, clientConsent: i.clientConsent, numbers: i.numbers }));
  const proof = proofDetail.map((p) => ({ id: p.id, title: p.title, numbers: p.numbers, clientConsent: p.clientConsent }));

  const cited: CitedSource[] = [];
  let ownPost: { externalPostId: string; url: string } | null = null;
  if (contentId) {
    const content = await getContent(ws, contentId);
    const src = content ? await remixSourceFor(ws, content) : null;
    if (src?.own) ownPost = { externalPostId: src.externalPostId, url: src.url };
    const refs = content?.source_refs ?? [];
    const trendIds = refs.filter((r) => r.type === "trend" && r.id && UUID_RE.test(r.id)).map((r) => r.id!);
    // A remixed post is a structure to follow, never a source of facts: its numbers and claims are its creator's.
    if (trendIds.length > 0) {
      const rows = await ws.sql<{ id: string; title: string; url: string }[]>`select id, title, url from trends where workspace_id = ${ws.id} and id = any(${trendIds}::uuid[])`;
      for (const r of rows) cited.push({ id: r.id, url: r.url, title: r.title });
    }
    for (const r of refs) {
      if ((r.type === "manual" || r.type === "url") && r.url && /^https:\/\//i.test(r.url)) cited.push({ id: r.id ?? r.url, url: r.url });
    }
  }

  const recentStats: SpentStat[] = [];
  if (settings.spentStatWindow > 0) {
    for (const s of await recentScripts(ws, { limit: settings.spentStatWindow, excludeContentId: contentId })) {
      for (const claim of s.claim_ledger ?? []) {
        if (claim.verdict !== "PASS") continue;
        for (const n of extractNumbers(claim.claim, { all: true })) recentStats.push({ value: n.value, usedAt: s.created_at.toISOString(), scriptRef: s.title });
      }
    }
  }
  return { proof, cited, own: ownSources(ws, ownPost), recentStats, proofDetail };
}

export async function buildScriptRules(ws: WorkspaceContext, contentId: string | null, settings: ScriptingSettings = scriptingSettings(ws)): Promise<ScriptRules> {
  const kit = ws.brand();
  const voice = parseBannedFromVoiceMd(kit.docs.voice ?? "");
  const banned = mergeBanned({ phrases: kit.brand.bannedPhrases }, voice);
  const sources = await getClaimSources(ws, contentId, settings);
  const content = contentId ? await getContent(ws, contentId) : null;
  const source = content ? await remixSourceFor(ws, content) : null;
  const [minSeconds, maxSeconds] = lengthWindow(settings, source);
  // A number in the proof beat is required only when there is one to cite; a remix's proof may be a story or demo.
  const hasNumbers = sources.proof.some((p) => p.numbers.length > 0) || sources.cited.some((c) => (c.numbers?.length ?? 0) > 0);
  return {
    ...(source ? { remix: remixRulesFor(source) } : {}),
    proofNumber: source || !hasNumbers ? "warn" : "error",
    wpm: settings.wpm,
    minSeconds,
    maxSeconds,
    hookMaxSeconds: settings.hookMaxSeconds,
    bannedOpeners: banned.openers,
    bannedPhrases: banned.phrases,
    allowedCaps: settings.allowedCaps,
    ctaLines: settings.ctaLines,
    keywordLedger: await ledgerWords(ws, contentId),
    claimSources: { proof: sources.proof, cited: sources.cited, own: sources.own, recentStats: sources.recentStats },
    knownPatterns: HOOK_PATTERN_IDS,
    captions: { platforms: captionPlatforms(ws), hashtagPool: kit.brand.hashtagPool },
  };
}

/** Validator report as stored in scripts.validator_report. */
export function storedReport(report: ValidationResult, now: Date) {
  return { ok: report.ok, errors: report.errors, warnings: report.warnings, checkedAt: now.toISOString(), validator: "@attentionos/guardrails validateScript" };
}

export type ValidatedPackage = { pkg: ScriptPackage | null; report: ValidationResult };

/** Parses and validates a package for a content item, adding the checks that need the database. */
export async function validateForContent(ws: WorkspaceContext, content: ContentRow, raw: unknown, rules?: ScriptRules): Promise<ValidatedPackage> {
  const parsed = scriptPackageSchema.safeParse(raw);
  if (!parsed.success) {
    const c = new IssueCollector();
    for (const i of zodIssuesToIssues(parsed.error.issues, "script")) c.error(i.code, `The script package has the wrong shape: ${i.message}.`, { path: i.path, fix: "Send every field of the script package with the documented types." });
    return { pkg: null, report: c.result() };
  }
  const pkg = parsed.data;
  const r = rules ?? (await buildScriptRules(ws, content.id));
  const c = new IssueCollector();
  c.merge(validateScript(pkg, r));

  // Checks that need the database.
  if (content.cta_type && content.cta_type !== pkg.cta.type) {
    c.warn("cta.type_changed", `The brief asks for a ${content.cta_type} CTA but the script uses ${pkg.cta.type}.`, { path: "cta.type", fix: "Use the brief's CTA type unless there's a reason to change it." });
  }
  const hookId = pkg.hookSource.hookId;
  if (hookId) {
    const rows = UUID_RE.test(hookId) ? await ws.sql<{ id: string; pattern: string }[]>`select id, pattern from hooks where workspace_id = ${ws.id} and id = ${hookId}` : [];
    if (rows.length === 0) c.error("hook_source.unknown_hook", `hook_source points at hook ${hookId}, which isn't in the hook banks.`, { path: "hookSource.hookId", fix: "Use an id from the hook list, or set origin to fresh with no hookId." });
  }
  return { pkg, report: c.result() };
}

// ---------------------------------------------------------------------------
// Keyword reservation
// ---------------------------------------------------------------------------

export type ReserveResult =
  | { reserved: true; keyword: string; id: string; released: string | null }
  | { reserved: false; problems: ValidationResult; suggestions: string[] };

/**
 * Reserves a keyword for a content item. Ledger rules are enforced here, under a per-workspace advisory lock
 * so two reservations can't both pass the collision check; the unique (workspace_id, word) constraint is the
 * last line of defence. A previous unused reservation for the same content is released.
 */
export async function reserveKeyword(ws: WorkspaceContext, actor: Actor, input: { contentId: string; keyword: string; scriptText?: string }): Promise<ReserveResult> {
  const content = requireContent(await getContent(ws, input.contentId), input.contentId);
  const word = normalizeKeyword(input.keyword);
  const latest = input.scriptText ?? (await latestScript(ws, content.id))?.body ?? "";
  try {
    return await ws.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      await sql`select pg_advisory_xact_lock(hashtext(${`aos:keywords:${ws.id}`}))`;
      const ledger = await ledgerWords(ws, content.id, sql);
      const check = checkKeyword(word, ledger, latest);
      if (!check.ok) {
        return { reserved: false as const, problems: check, suggestions: suggestKeywords({ topicText: `${content.title} ${content.angle ?? ""}`, ledgerWords: ledger, scriptText: latest, count: 5 }) };
      }
      const previous = await sql<{ id: string; word: string; status: string }[]>`
        select id, word::text as word, status from keywords where workspace_id = ${ws.id} and content_id = ${content.id}`;
      if (previous.some((p) => p.status !== "reserved")) {
        throw new ToolError("This content already has a live keyword; it can't be swapped.", "Live keywords stay attached to their post forever.");
      }
      const same = previous.find((p) => p.word.toLowerCase() === word);
      if (same) return { reserved: true as const, keyword: word, id: same.id, released: null };
      const inserted = await sql<{ id: string }[]>`
        insert into keywords (workspace_id, word, status, content_id) values (${ws.id}, ${word}, 'reserved', ${content.id}) returning id`;
      const id = inserted[0]!.id;
      let released: string | null = null;
      if (previous.length > 0) {
        await sql`delete from keywords where workspace_id = ${ws.id} and id = any(${previous.map((p) => p.id)}::uuid[])`;
        released = previous.map((p) => p.word).join(", ");
      }
      await sql`update content set keyword_id = ${id}, updated_at = now() where workspace_id = ${ws.id} and id = ${content.id}`;
      ws.log.info("keyword reserved", { contentId: content.id, keyword: word, actor });
      return { reserved: true as const, keyword: word, id, released };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      const ledger = await ledgerWords(ws, content.id);
      return {
        reserved: false,
        problems: { ok: false, errors: [{ code: "keyword.taken", message: `Keyword "${word}" was just taken by another piece of content.`, fix: "Pick another word." }], warnings: [] },
        suggestions: suggestKeywords({ topicText: content.title, ledgerWords: ledger, scriptText: latest, count: 5 }),
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Saving scripts and approvals
// ---------------------------------------------------------------------------

export type SaveScriptInput = {
  contentId: string;
  package: unknown;
  requestApproval?: boolean;
  status?: "draft" | "approved";
  runId?: string | null;
};

export type SaveScriptResult = {
  saved: boolean;
  ok: boolean;
  scriptId: string | null;
  version: number | null;
  approvalRef: string | null;
  report: ValidationResult;
  /** Consecutive failing drafts for this content, including this one. */
  failedDrafts: number;
  /** True when the revision budget is spent: stop revising and leave it to a person. */
  stop: boolean;
  message: string;
};

export async function requestApproval(
  ws: WorkspaceContext,
  sql: Sql,
  input: { kind: "script" | "post"; subjectType: string; subjectId: string; summary: string; preview: Record<string, unknown>; runId?: string | null },
): Promise<string> {
  const ref = await nextRef(sql, ws.id, "ap");
  await sql`
    update approvals set status = 'revised', decided_at = now(), decided_by = 'system', decision_note = 'A newer version was submitted.'
     where workspace_id = ${ws.id} and status = 'pending' and subject_type = ${input.subjectType}
       and preview ->> 'contentId' = ${String(input.preview.contentId ?? "")}`;
  await sql`
    insert into approvals (workspace_id, ref, kind, subject_type, subject_id, agent, status, summary, preview, run_id)
    values (${ws.id}, ${ref}, ${input.kind}, ${input.subjectType}, ${input.subjectId}, 'copywriter', 'pending', ${input.summary}, ${jsonb(sql, input.preview)},
            ${input.runId && UUID_RE.test(input.runId) ? input.runId : null})`;
  return ref;
}

export async function saveScript(ws: WorkspaceContext, actor: Actor, input: SaveScriptInput): Promise<SaveScriptResult> {
  const settings = scriptingSettings(ws);
  const content = requireContent(await getContent(ws, input.contentId), input.contentId);
  const wantsApproved = input.status === "approved";
  if (wantsApproved && !actor.startsWith("user:")) {
    throw new ToolError("Only a person can approve a script.", "Save it as a draft with requestApproval and the owner approves it from the approvals queue.");
  }
  const { pkg, report: baseReport } = await validateForContent(ws, content, input.package);
  if (!pkg) {
    const failed = (await consecutiveFailures(ws, content.id)) + 1;
    return { saved: false, ok: false, scriptId: null, version: null, approvalRef: null, report: baseReport, failedDrafts: failed, stop: failed > settings.maxRevisions, message: "Not saved: the package is missing fields. Fix the shape and send it again." };
  }
  if (wantsApproved && !baseReport.ok) {
    throw new ToolError(`This script can't be approved: ${baseReport.errors.length} check${baseReport.errors.length === 1 ? "" : "s"} fail.`, baseReport.errors.map((e) => e.message).join(" "));
  }

  let report = baseReport;
  // Reserve the keyword the script uses (enforces the ledger rules again under a lock).
  const kw = pkg.cta.keyword?.trim();
  if (report.ok && kw && KEYWORD_CTAS.has(pkg.cta.type)) {
    const reservation = await reserveKeyword(ws, actor, { contentId: content.id, keyword: kw, scriptText: pkg.body });
    if (!reservation.reserved) report = { ok: false, errors: [...report.errors, ...reservation.problems.errors], warnings: report.warnings };
  }

  const now = ws.now();
  // On autopilot the Copywriter's passing scripts go straight to "ready to film"; otherwise a person approves them.
  const autoApproved = !wantsApproved && report.ok && input.requestApproval !== false && agentSettings(ws.config, "copywriter").autonomy === "autopilot";
  const status = (wantsApproved || autoApproved) && report.ok ? "approved" : "draft";
  const result = await ws.sql.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    let row: { id: string; version: number } | undefined;
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      try {
        const rows = await sql<{ id: string; version: number }[]>`
          insert into scripts (workspace_id, content_id, version, body, beats, hook_text, hook_source, claim_ledger, validator_report, captions, status, created_by)
          values (${ws.id}, ${content.id},
                  (select coalesce(max(version), 0) + 1 from scripts where workspace_id = ${ws.id} and content_id = ${content.id}),
                  ${pkg.body}, ${jsonb(sql, pkg.beats)}, ${pkg.hookText},
                  ${jsonb(sql, { hook_id: pkg.hookSource.hookId ?? null, pattern: pkg.hookSource.pattern, origin: pkg.hookSource.origin, ref: pkg.hookSource.ref ?? null })},
                  ${jsonb(sql, pkg.claimLedger)}, ${jsonb(sql, storedReport(report, now))}, ${pkg.captions ? jsonb(sql, pkg.captions) : null},
                  ${status}, ${actor})
          returning id, version`;
        row = rows[0];
      } catch (err) {
        if ((err as { code?: string }).code !== "23505" || attempt === 2) throw err;
      }
    }
    const saved = row!;
    await sql`update scripts set status = 'superseded' where workspace_id = ${ws.id} and content_id = ${content.id} and id <> ${saved.id}
                and (status = 'draft' or (${status === "approved"} and status = 'approved'))`;
    if (status === "approved") {
      await sql`
        update approvals set status = 'revised', decided_at = now(), decided_by = 'system', decision_note = 'A newer version was approved.'
         where workspace_id = ${ws.id} and status = 'pending' and kind = 'script' and subject_type = 'script'
           and preview ->> 'contentId' = ${content.id}`;
    }
    let approvalRef: string | null = null;
    if (report.ok) {
      const hookId = pkg.hookSource.hookId && UUID_RE.test(pkg.hookSource.hookId) ? pkg.hookSource.hookId : null;
      if (hookId && content.hook_id !== hookId) {
        await sql`update hooks set uses = uses + 1, last_used_at = ${now} where workspace_id = ${ws.id} and id = ${hookId}`;
      }
      await sql`
        update content set status = case when status = 'idea' then 'scripted' else status end,
                           hook_id = ${hookId}, hook_pattern = ${pkg.hookSource.pattern}, cta_type = ${pkg.cta.type}, updated_at = ${now}
         where workspace_id = ${ws.id} and id = ${content.id}`;
      if (status !== "approved" && input.requestApproval !== false) {
        approvalRef = await requestApproval(ws, sql, {
          kind: "script",
          subjectType: "script",
          subjectId: saved.id,
          summary: `Script ready for review: ${content.title}`,
          preview: { contentId: content.id, version: saved.version, title: pkg.title, hook: pkg.hookText, ctaType: pkg.cta.type, keyword: kw ?? null, warnings: report.warnings.length },
          runId: input.runId ?? null,
        });
      }
    }
    return { ...saved, approvalRef };
  });

  const failedDrafts = report.ok ? 0 : await consecutiveFailures(ws, content.id);
  const stop = !report.ok && failedDrafts > settings.maxRevisions;
  const message = report.ok
    ? status === "approved"
      ? autoApproved
        ? `Saved version ${result.version}; all checks pass and it's ready to film (the Copywriter is on autopilot).`
        : `Saved and approved version ${result.version}.`
      : `Saved version ${result.version}; all checks pass.${result.approvalRef ? ` Waiting for review (${result.approvalRef}).` : ""}`
    : stop
      ? `Saved version ${result.version} as a draft, but ${failedDrafts} drafts in a row failed the checks. Stop revising; the owner will fix this one.`
      : `Saved version ${result.version} as a draft. ${report.errors.length} check${report.errors.length === 1 ? "" : "s"} fail; fix them and save again (${settings.maxRevisions + 1 - failedDrafts} revision${settings.maxRevisions + 1 - failedDrafts === 1 ? "" : "s"} left).`;
  return { saved: true, ok: report.ok, scriptId: result.id, version: result.version, approvalRef: result.approvalRef, report, failedDrafts, stop, message };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type HookView = {
  id: string;
  origin: HookRow["origin"];
  pattern: string;
  patternName: string | null;
  score: number | null;
  uses: number;
  wins: number;
  /** Own and manual hooks only. Competitor hooks are untrusted text and are shown as structure only. */
  text?: string;
  /** Structure with [placeholders]. */
  structure: string;
  lastUsedAt: string | null;
};

export function hookView(row: HookRow): HookView {
  const pattern = getPattern(row.pattern);
  const structure = row.abstract ?? pattern?.template ?? "[unclassified structure]";
  const view: HookView = {
    id: row.id,
    origin: row.origin,
    pattern: row.pattern,
    patternName: pattern?.name ?? null,
    score: row.score === null ? null : Number(row.score),
    uses: row.uses,
    wins: row.wins,
    structure,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
  if (row.origin !== "competitor") view.text = row.text;
  return view;
}

export async function listHooks(
  ws: WorkspaceContext,
  opts: { origin?: "own" | "competitor" | "manual" | "all"; pattern?: string; limit?: number; includeRetired?: boolean; excludeCoolingDown?: boolean },
): Promise<HookRow[]> {
  const settings = scriptingSettings(ws);
  const origin = !opts.origin || opts.origin === "all" ? null : opts.origin;
  const cutoff = opts.excludeCoolingDown ? new Date(ws.now().getTime() - settings.hookCooldownDays * 86_400_000) : null;
  return ws.sql<HookRow[]>`
    select id, text, pattern, origin, source_ref, uses, wins, score, status, abstract, last_used_at, created_at
      from hooks
     where workspace_id = ${ws.id}
       and (${origin}::text is null or origin = ${origin})
       and (${opts.pattern ?? null}::text is null or pattern = ${opts.pattern ?? null})
       and (${opts.includeRetired === true} or status = 'active')
       and (${cutoff}::timestamptz is null or last_used_at is null or last_used_at < ${cutoff})
       and pattern <> ${UNCLASSIFIED}
     order by case origin when 'own' then 0 when 'manual' then 1 else 2 end, score desc nulls last, created_at desc
     limit ${opts.limit ?? 50}`;
}

export async function pickHooks(ws: WorkspaceContext, opts: { count?: number; rng?: () => number; weights?: Record<string, number> } = {}): Promise<{ picks: (HookPick & { view: HookView })[]; weightsSource: "learn" | "uniform" }> {
  const settings = scriptingSettings(ws);
  const rows = await listHooks(ws, { origin: "all", limit: 500, excludeCoolingDown: true });
  const weights = opts.weights ?? (await loadLearnWeights(ws));
  const candidates: HookCandidate[] = rows.map((r) => ({ id: r.id, pattern: r.pattern, origin: r.origin, score: r.score === null ? null : Number(r.score) }));
  const picks = selectHooks(candidates, weights, { count: opts.count ?? 3, exploration: settings.exploration, rng: opts.rng });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { picks: picks.map((p) => ({ ...p, view: hookView(byId.get(p.id)!) })), weightsSource: Object.keys(weights).length > 0 ? "learn" : "uniform" };
}

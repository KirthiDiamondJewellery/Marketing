import { z } from "zod";
import { compact, defineTool, ToolError, type ToolDefinition } from "@attentionos/core";
import { extractNumbers } from "@attentionos/guardrails";
import { saveCaptions, saveTextPosts } from "../copy.ts";
import { getContent, ledgerWords, latestScript, recentScripts } from "../db.ts";
import { dryRunValidate } from "../jobs/write-script.ts";
import { applyPatch, completePackage, lastPackage, rememberPackage } from "../package-edit.ts";
import { findRemixSources, useRemixSource } from "../remix.ts";
import { getClaimSources, getContentBrief, hookView, listHooks, pickHooks, reserveKeyword, saveScript } from "../service.ts";
import { suggestKeywords } from "@attentionos/guardrails";
import { HOOK_PATTERN_IDS, HOOK_PATTERNS } from "../taxonomy.ts";

const contentId = z.string().uuid().describe("content.id of the piece being scripted");
const scriptPackage = z.record(z.string(), z.unknown()).describe("The full script package JSON (title, body, beats, hookText, hookSource, cta, claimLedger, captions).");

export const getContentBriefTool = defineTool({
  name: "scripting_get_content_brief",
  description: "Get everything needed to script one content item: the brief, lane, funnel stage, CTA type, reserved keyword, the length window and which Brand Kit files to read first.",
  input: z.object({ contentId }),
  annotations: { readOnly: true },
  handler: async ({ ws }, input) => compact(await getContentBrief(ws, input.contentId)),
});

export const listHooksTool = defineTool({
  name: "scripting_list_hooks",
  description: "List hooks from the banks. Own and manual hooks include their words; competitor hooks show only their structure (a remix's own source hook comes with its blueprint instead). Filter by bank and pattern.",
  input: z.object({
    bank: z.enum(["own", "competitor", "manual", "all"]).default("all"),
    pattern: z.string().optional().describe(`One of: ${HOOK_PATTERN_IDS.join(", ")}`),
    limit: z.number().int().min(1).max(100).default(20),
    includeTaxonomy: z.boolean().default(false).describe("Also return the pattern taxonomy with definitions and templates."),
  }),
  annotations: { readOnly: true },
  handler: async ({ ws }, input) => {
    const rows = await listHooks(ws, { origin: input.bank, pattern: input.pattern, limit: input.limit });
    return compact({
      hooks: rows.map(hookView),
      taxonomy: input.includeTaxonomy ? HOOK_PATTERNS.map((p) => ({ id: p.id, name: p.name, definition: p.definition, template: p.template, whenToUse: p.whenToUse })) : undefined,
    });
  },
});

export const pickHooksTool = defineTool({
  name: "scripting_pick_hooks",
  description: "Pick hook candidates with different patterns, weighted by what has worked for this account (with some exploration). Use one of them and record it in hookSource.",
  input: z.object({ count: z.number().int().min(1).max(6).default(3) }),
  annotations: { readOnly: true },
  handler: async ({ ws }, input) => {
    const res = await pickHooks(ws, { count: input.count });
    return compact({ weights: res.weightsSource, picks: res.picks.map((p) => ({ ...p.view, reason: p.reason })) });
  },
});

export const validateScriptTool = defineTool({
  name: "scripting_validate_script",
  description: "Dry-run the script validator on a package without saving it. Returns every failing check with the exact fix. (scripting_save_script runs the same checks, so when you mean to save, just save.)",
  input: z.object({ contentId, package: scriptPackage }),
  annotations: { readOnly: true },
  handler: async ({ ws }, input) => {
    const report = await dryRunValidate(ws, input.contentId, completePackage(input.package));
    return { ok: report.ok, errors: report.errors, warnings: report.warnings };
  },
});

const patchSchema = z.record(z.string(), z.unknown()).describe(
  "Only the fields to change since the last package you sent for this content in this run: e.g. {\"beatEdits\": [{\"index\": 2, \"text\": \"...\"}]}, " +
    "{\"claimLedger\": [...]}, or {\"captions\": {\"tiktok\": {...}}} (captions merge per platform). The body and hook text are rebuilt from the beats.",
);

export const saveScriptTool = defineTool({
  name: "scripting_save_script",
  description:
    "Check and save a new version of a script in one call. The validator runs in code and its report is stored with the version. Passing scripts are sent for review; " +
    "failing ones are saved as drafts and the reply lists the exact fixes: send just those changes back as `patch` instead of the whole package. " +
    "`body` and `hookText` may be left out (built from the beats). Only a person can save with status approved, and never when a check fails.",
  input: z.object({
    contentId,
    package: scriptPackage.optional(),
    patch: patchSchema.optional(),
    requestApproval: z.boolean().default(true),
    status: z.enum(["draft", "approved"]).default("draft"),
  }),
  annotations: { destructive: false },
  handler: async ({ ws, actor }, input) => {
    let pkg: Record<string, unknown>;
    if (input.patch) {
      const base = input.package ? completePackage(input.package) : lastPackage(input.contentId);
      if (!base) throw new ToolError("There's no earlier package for this content in this run to patch.", "Send the full package once; after that, patches work.");
      pkg = applyPatch(base, input.patch);
    } else if (input.package) {
      pkg = completePackage(input.package);
    } else {
      throw new ToolError("Send the script package (or a patch to the last one).");
    }
    rememberPackage(input.contentId, pkg);
    const res = await saveScript(ws, actor, { contentId: input.contentId, package: pkg, requestApproval: input.requestApproval, status: input.status });
    return compact({
      ...res, errors: res.report.errors, warnings: res.report.warnings, report: undefined,
      next: res.ok
        ? "Done: it passed and is waiting for review. Warnings are notes for the owner; don't save again for them. Write your summary."
        : res.stop ? undefined : "Fix exactly these and call again with only the changed fields as patch.",
    });
  },
});

export const reserveKeywordTool = defineTool({
  name: "scripting_reserve_keyword",
  description: "Reserve a comment keyword for a content item. Enforces the ledger: 4 to 9 letters A to Z, never used, no overlap with any used keyword, not a word in the script. Leave keyword out to get suggestions.",
  input: z.object({ contentId, keyword: z.string().optional(), candidates: z.array(z.string()).max(20).optional() }),
  handler: async ({ ws, actor }, input) => {
    if (!input.keyword) {
      const content = await getContent(ws, input.contentId);
      if (!content) throw new ToolError(`No content item with id ${input.contentId} in this workspace.`);
      const script = (await latestScript(ws, content.id))?.body ?? "";
      return { suggestions: suggestKeywords({ topicText: `${content.title} ${content.angle ?? ""}`, ledgerWords: await ledgerWords(ws, content.id), scriptText: script, candidates: input.candidates, count: 5 }) };
    }
    const res = await reserveKeyword(ws, actor, { contentId: input.contentId, keyword: input.keyword });
    if (res.reserved) return { reserved: true, keyword: res.keyword.toUpperCase(), released: res.released ?? undefined };
    return { reserved: false, errors: res.problems.errors, suggestions: res.suggestions };
  },
});

export const getClaimSourcesTool = defineTool({
  name: "scripting_get_claim_sources",
  description: "Get the only allowed sources of numbers and facts: proof inventory items (with their recorded numbers and client-consent flag), the cited sources attached to this content, and stats already spent in recent scripts.",
  input: z.object({ contentId: contentId.optional() }),
  annotations: { readOnly: true },
  handler: async ({ ws }, input) => {
    const s = await getClaimSources(ws, input.contentId ?? null);
    return compact({
      proof: s.proofDetail.map((p) => ({ ref: `proof:${p.id}`, ...p })),
      cited: s.cited.map((c) => ({ ref: `cited:${c.id}`, ...c })),
      spentStats: s.recentStats,
    });
  },
});

export const listRecentScriptsTool = defineTool({
  name: "scripting_list_recent_scripts",
  description: "List the latest script of recent content items: title, version, status, hook pattern, keyword and the numbers each one used (spent stats). Use it to avoid repeating hooks, angles and stats.",
  input: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  annotations: { readOnly: true },
  handler: async ({ ws }, input) => {
    const rows = await recentScripts(ws, { limit: input.limit });
    return compact({
      scripts: rows.map((r) => ({
        contentId: r.content_id,
        title: r.title,
        version: r.version,
        status: r.status,
        hook: r.hook_text,
        hookPattern: (r.hook_source?.pattern as string | undefined) ?? null,
        keyword: r.keyword,
        passedChecks: r.validator_report?.ok ?? null,
        numbersUsed: [...new Set((r.claim_ledger ?? []).filter((c) => c.verdict === "PASS").flatMap((c) => extractNumbers(c.claim, { all: true }).map((n) => n.raw)))],
        createdAt: r.created_at.toISOString(),
      })),
    });
  },
});

export const saveCaptionsTool = defineTool({
  name: "scripting_save_captions",
  description: "Save per-platform captions (strict JSON) on the latest script version. They are validated in code first: IG contains the keyword, TikTok and YouTube use 'DM me WORD' or 'link in bio', YouTube titles under 100 characters, X within 280, 3 to 5 niche hashtags.",
  input: z.object({ contentId, captions: z.record(z.string(), z.unknown()) }),
  handler: async ({ ws, actor }, input) => {
    const res = await saveCaptions(ws, actor, input);
    return { saved: res.saved, version: res.version, errors: res.report.errors, warnings: res.report.warnings };
  },
});

export const saveTextPostsTool = defineTool({
  name: "scripting_save_text_posts",
  description: "Save the weekly text posts (X, Threads, LinkedIn). Each post is validated in code; LinkedIn long-form also needs rubric scores (8 overall, no criterion under 7). Valid posts are saved and sent for review; invalid ones come back with fixes.",
  input: z.object({
    weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    posts: z.array(z.object({
      platform: z.enum(["x", "threads", "linkedin"]),
      title: z.string().optional(),
      text: z.string().min(1),
      hashtags: z.array(z.string()).default([]),
      rubric: z.record(z.string(), z.number()).optional(),
      hasVisual: z.boolean().optional(),
    })).min(1).max(30),
  }),
  handler: async ({ ws, actor }, input) => {
    const res = await saveTextPosts(ws, actor, input);
    return { results: res.results.map((r) => compact({ index: r.index, platform: r.platform, saved: r.saved, contentId: r.contentId, approvalRef: r.approvalRef, errors: r.report.errors, warnings: r.report.warnings })) };
  },
});

export const findRemixSourcesTool = defineTool({
  name: "scripting_find_remix_sources",
  description:
    "Find proven posts to remake for a topic: competitor outliers and the owner's own breakouts, ranked by how well they match the topic and how far they beat their creator's normal. " +
    "ready means a checked blueprint exists (hook line, beats, format, CTA mechanic), so the script can follow it beat for beat. Returns facts only, never the post's text.",
  input: z.object({
    topic: z.string().trim().min(3).max(200).describe("What the script is about, in a few words"),
    limit: z.number().int().min(1).max(10).default(5),
    sinceDays: z.number().int().min(7).max(365).default(180),
    includeUsed: z.boolean().default(false).describe("Also return posts already remixed into another piece"),
  }),
  annotations: { readOnly: true },
  handler: async ({ ws }, input) => {
    const found = await findRemixSources(ws, input);
    return compact({ count: found.length, sources: found, hint: found.length ? undefined : "No proven post matches this topic. Write an original modelled on brief.ownWinners." });
  },
});

export const useRemixSourceTool = defineTool({
  name: "scripting_use_remix_source",
  description: "Make this content item a remix of one proven post (an externalPostId from scripting_find_remix_sources). Records the source on the content, so the brief, the checks and Studio all show it. Returns the remix view; call scripting_get_content_brief again after.",
  input: z.object({ contentId, externalPostId: z.string().uuid() }),
  handler: async ({ ws, actor }, input) => compact(await useRemixSource(ws, actor, input)),
});

export const scriptingTools: ToolDefinition[] = [
  findRemixSourcesTool,
  useRemixSourceTool,
  getContentBriefTool,
  listHooksTool,
  pickHooksTool,
  validateScriptTool,
  saveScriptTool,
  reserveKeywordTool,
  getClaimSourcesTool,
  listRecentScriptsTool,
  saveCaptionsTool,
  saveTextPostsTool,
] as unknown as ToolDefinition[];

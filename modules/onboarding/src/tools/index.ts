import { defineTool, ToolError, type ToolContext } from "@attentionos/core";
import { z } from "zod";
import { BrandFileError, contentHash, WRITABLE_BRAND_FILES, writeBrandFile } from "../lib/brand-files.ts";
import { ANSWER_KINDS, initialState, readState, updateState } from "../lib/state.ts";

/**
 * MCP tools for onboarding. The interview agent records facts with `onboarding_record_answer`; any agent (or the
 * owner's Claude Code in Copilot) can write a validated Brand Kit file with `onboarding_save_brand_file`, which only
 * accepts files under brand/ and checks YAML against the core Brand Kit schemas before writing.
 */

export const getStateTool = defineTool({
  name: "onboarding_get_state",
  description:
    "Read the setup wizard's progress: which steps are done or skipped, the approved business basics and offers, the owner's handles, the voice profile summary and the interview answers recorded so far. Use it before asking the owner anything, so you never ask twice.",
  input: z.object({}),
  annotations: { readOnly: true, idempotent: true },
  async handler(ctx: ToolContext) {
    const s = (await readState(ctx.ws.sql, ctx.ws.id)) ?? initialState(ctx.ws.now());
    const d = s.data;
    return {
      step: s.step,
      completed: s.completed,
      skipped: d.skipped,
      business: d.business.draft
        ? {
            approved: Boolean(d.business.approvedAt),
            name: d.business.draft.name,
            oneLiner: d.business.draft.oneLiner,
            website: d.business.draft.website,
            offers: d.business.draft.offers.map((o) => ({ name: o.name, whoFor: o.whoFor, cta: o.cta })),
            audience: d.business.draft.audience,
            openQuestions: d.business.draft.openQuestions,
          }
        : null,
      handles: d.content.handles,
      postsImported: d.content.posts.filter((p) => p.text).length,
      voice: d.voice.draft ? { approved: Boolean(d.voice.approvedAt), oneLine: d.voice.draft.oneLine, summary: d.voice.draft.summary } : null,
      interview: {
        answers: d.interview.answers.map((a) => ({ kind: a.kind, text: a.text, numbers: a.numbers })),
        turns: d.interview.messages.length,
        done: d.interview.done,
      },
    };
  },
});

const numberSchema = z.object({
  value: z.string().min(1).max(60).describe('The number as said, e.g. "40%" or "3 weeks".'),
  label: z.string().min(1).max(200).describe("What it measures."),
  source: z.string().min(3).max(200).describe('Where it comes from, e.g. "owner, onboarding interview 2026-10-12" or a link. Required.'),
});

export const recordAnswerTool = defineTool({
  name: "onboarding_record_answer",
  description:
    "Record one fact the owner told you in the onboarding interview: a customer pain, want or exact quote, an objection, an offer detail, a proof point (case study, client win, FAQ, process, story) or who it's not for. One call per fact. Numbers need the source the owner gave; never record a number they didn't state. Set clientConsent only when the owner confirmed the client agreed to be named.",
  input: z.object({
    kind: z.enum(ANSWER_KINDS),
    text: z.string().min(3).max(2000).describe("The fact in the owner's words (customers' quotes verbatim)."),
    numbers: z.array(numberSchema).max(10).default([]),
    clientConsent: z.boolean().default(false),
  }),
  annotations: { idempotent: true },
  async handler(ctx, input) {
    const at = ctx.ws.now().toISOString();
    const text = input.text.trim();
    const s = await updateState(ctx.ws.sql, ctx.ws.id, (st) => {
      if (st.data.interview.answers.some((a) => a.kind === input.kind && a.text === text)) return st;
      if (st.data.interview.answers.length >= 200) throw new ToolError("The interview already holds 200 answers.", "Wrap up and show the owner the summary.");
      const answers = [...st.data.interview.answers, { kind: input.kind, text, numbers: input.numbers, clientConsent: input.clientConsent, at }];
      return { ...st, data: { ...st.data, interview: { ...st.data.interview, answers } } };
    });
    const counts: Record<string, number> = {};
    for (const a of s.data.interview.answers) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    return { recorded: true, totals: counts };
  },
});

export const saveBrandFileTool = defineTool({
  name: "onboarding_save_brand_file",
  description: `Write one Brand Kit file after the owner approved it. Only these files are accepted: ${WRITABLE_BRAND_FILES.map((f) => `brand/${f}`).join(", ")}. YAML files are checked against the Brand Kit schemas and pillars.md front matter must hold valid lanes; every number in proof-inventory.yaml needs a source. Send the COMPLETE file content (read the current file first and keep its comments and structure). Nothing is written when validation fails.`,
  input: z.object({
    file: z.string().min(3).max(80).describe('e.g. "brand/icp.md" or "brand/proof-inventory.yaml".'),
    content: z.string().min(1).max(256 * 1024),
  }),
  annotations: { destructive: true },
  async handler(ctx, input) {
    let written: ReturnType<typeof writeBrandFile>;
    try {
      written = writeBrandFile(ctx.ws.paths.root, input.file, input.content);
    } catch (err) {
      if (err instanceof BrandFileError) throw new ToolError(err.message, "Fix the content and call onboarding_save_brand_file again with the whole file.");
      throw err;
    }
    if (written.changed) {
      await ctx.ws.sql`
        insert into brand_docs (workspace_id, path, content, content_hash, updated_at)
        values (${ctx.ws.id}, ${written.path}, ${input.content.replace(/\r\n/g, "\n")}, ${contentHash(input.content.replace(/\r\n/g, "\n"))}, now())
        on conflict (workspace_id, path) do update set content = excluded.content, content_hash = excluded.content_hash, updated_at = now()`.catch(() => {});
      try {
        ctx.ws.reloadBrand();
      } catch {
        // A partly filled Brand Kit may not load yet; the file itself is valid.
      }
      // Keep the knowledge store in step (the knowledge module's job; it simply fails if that module is off).
      await ctx.ws.sql`
        insert into agent_runs (workspace_id, agent, job_id, trigger, input, created_by, dedupe_key, max_attempts)
        values (${ctx.ws.id}, 'analyst', 'knowledge.index-path', 'event', ${ctx.ws.sql.json({ path: written.path })}, ${ctx.actor},
                ${`knowledge:index:${written.path}:${written.hash.slice(0, 12)}`}, 1)
        on conflict do nothing`.catch(() => {});
    }
    return { saved: written.path, bytes: written.bytes, changed: written.changed };
  },
});

export const onboardingTools = [getStateTool, recordAnswerTool, saveBrandFileTool];

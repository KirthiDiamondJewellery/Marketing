import { defineTool, type ToolDefinition } from "@attentionos/core";
import { z } from "zod";
import { addRevisionNote, approveCutList, getEditJobView, getPlanContext, getQcReport, requestRender, savePlan, startEdit } from "../service.ts";

const ref = z.string().regex(/^rf-\d+$/i, "an edit ref like rf-12").describe('Edit ref, e.g. "rf-12".');

export const editingTools = [
  defineTool({
    name: "editing_start_edit",
    description:
      "Start editing a raw video file into a reel. Prepares the footage (proxy, transcript, silence map) and builds a cut list for review. Returns the edit ref (rf-N).",
    input: z.object({
      path: z.string().min(1).describe("Path to the raw video: absolute, or relative to the workspace (e.g. media/raw/take1.mov)."),
      contentId: z.string().uuid().optional().describe("The content item this video is for, if any."),
      format: z.string().optional().describe("Format template id (raw-talking-head, split-demo, news-greenscreen, popup-presenter)."),
    }),
    annotations: { destructive: false },
    handler: (ctx, input) => startEdit(ctx.ws, ctx.actor, input),
  }),
  defineTool({
    name: "editing_get_edit_job",
    description: "Status of an edit: the numbered cut list with reasons, plan check, QC result, output file and what it is waiting for.",
    input: z.object({ ref }),
    annotations: { readOnly: true, idempotent: true },
    handler: (ctx, input) => getEditJobView(ctx.ws, input.ref),
  }),
  defineTool({
    name: "editing_approve_cut_list",
    description:
      "Approve an edit's cut list (a person's sign-off), optionally putting cuts back or removing more first. Then the Art Director plans the edit.",
    input: z.object({
      ref,
      restore: z.array(z.number().int().positive()).optional().describe("Cut numbers (from the cut list) to put back."),
      add: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive(), reason: z.string().optional() })).optional().describe("Extra source-time ranges (seconds) to remove."),
      note: z.string().optional(),
    }),
    handler: (ctx, input) => approveCutList(ctx.ws, ctx.actor, input.ref, input),
  }),
  defineTool({
    name: "editing_get_plan",
    description:
      "Everything needed to write or revise the edit plan: format rules, the transcript in OUTPUT seconds, claim ids that may be shown, attached media, and the current (or a draft) plan without its source block.",
    input: z.object({ ref }),
    annotations: { readOnly: true, idempotent: true },
    handler: (ctx, input) => getPlanContext(ctx.ws, input.ref),
  }),
  defineTool({
    name: "editing_save_plan",
    description:
      "Save the edit plan. Omit `source`: the approved cut list, transcript and footage are filled in (pass `keepRanges` only to change the cut). The plan is validated against the EditPlan schema and the preflight plan gate; problems come back to fix.",
    input: z.object({ ref, plan: z.record(z.string(), z.unknown()).describe("EditPlan fields: format, layout, captions, overlays, broll, audio, camera, export, optional keepRanges.") }),
    handler: (ctx, input) => savePlan(ctx.ws, ctx.actor, input.ref, input.plan),
  }),
  defineTool({
    name: "editing_request_render",
    description: "Render the saved plan: cut engine, loudness finishing and QC, then it goes to the owner for approval.",
    input: z.object({ ref }),
    handler: (ctx, input) => requestRender(ctx.ws, ctx.actor, input.ref),
  }),
  defineTool({
    name: "editing_add_revision_note",
    description: 'Ask for changes to a rendered edit ("tighten the hook", "no music"). The Art Director revises the plan and re-renders only what changed.',
    input: z.object({ ref, note: z.string().min(2), fromVersion: z.number().int().positive().optional() }),
    handler: (ctx, input) => addRevisionNote(ctx.ws, ctx.actor, input.ref, input.note, input.fromVersion),
  }),
  defineTool({
    name: "editing_get_qc_report",
    description: "The export checks for the latest render: what passed, what failed and how to fix it.",
    input: z.object({ ref }),
    annotations: { readOnly: true, idempotent: true },
    handler: (ctx, input) => getQcReport(ctx.ws, input.ref),
  }),
] as unknown as ToolDefinition[];

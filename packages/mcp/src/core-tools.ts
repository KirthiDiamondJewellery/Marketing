import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { BRAND_FILES, defineTool, ToolError, type ToolDefinition } from "@attentionos/core";
import {
  agentColumn,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  ApprovalError,
  decideApproval,
  listApprovals,
  recordAgentEvent,
  requestApproval,
  type ApprovalRow,
} from "@attentionos/db";
import { appendLesson, localDate } from "./lessons.ts";
import { workspaceStatus, type StatusInfo } from "./status.ts";
import { readWorkspaceContent } from "./workspace-files.ts";

export type CoreToolsInfo = StatusInfo & {
  /** The agent run this server serves (Autopilot), so progress lands on the right run. */
  runId?: string;
};

/** Tools that write their own activity event; the server doesn't add a generic one for them. */
export const SELF_LOGGING_TOOLS = new Set(["core_log_progress", "core_request_approval", "core_decide_approval"]);

const BRAND_FILE_NAMES = Object.values(BRAND_FILES) as string[];

function brandFilePath(brandDir: string, name: string): string {
  const cleaned = name.trim().replace(/^brand\//, "");
  const withExt = BRAND_FILE_NAMES.includes(cleaned) || /\.(md|ya?ml)$/.test(cleaned)
    ? cleaned
    : (BRAND_FILE_NAMES.find((f) => f.replace(/\.(md|ya?ml)$/, "") === cleaned) ?? `${cleaned}.md`);
  const path = resolve(brandDir, withExt);
  const rel = relative(brandDir, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !/\.(md|ya?ml)$/.test(rel)) {
    throw new ToolError(`"${name}" is not a Brand Kit file.`, "Call core_brand_kit with no file to list the files.");
  }
  return path;
}

function listBrandFiles(brandDir: string): string[] {
  if (!existsSync(brandDir)) return [];
  const out = readdirSync(brandDir).filter((f) => /\.(md|ya?ml)$/.test(f));
  const knowledge = join(brandDir, "knowledge");
  if (existsSync(knowledge)) out.push(...readdirSync(knowledge).filter((f) => f.endsWith(".md")).map((f) => `knowledge/${f}`));
  return out.sort();
}

const approvalView = (a: ApprovalRow) => ({
  ref: a.ref,
  id: a.id,
  kind: a.kind,
  status: a.status,
  agent: a.agent,
  summary: a.summary,
  subject: a.subject_id ? `${a.subject_type}:${a.subject_id}` : a.subject_type,
  preview: a.preview,
  requestedAt: a.requested_at,
  decidedAt: a.decided_at,
  decidedBy: a.decided_by,
  note: a.decision_note,
});

async function approvalCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApprovalError) throw new ToolError(err.message, err.hint);
    throw err;
  }
}

export function coreTools(info: CoreToolsInfo): ToolDefinition[] {
  const status = defineTool({
    name: "core_status",
    description:
      "Overview of this AttentionOS workspace: modules that are on, providers, today's AI spend against the budget, approvals waiting and queued or failed runs. Call it first when you need to know what is set up.",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    handler: async ({ ws }) => workspaceStatus(ws, info),
  });

  const brandKit = defineTool({
    name: "core_brand_kit",
    description:
      "Read one Brand Kit file (voice, icp, offers, pillars, proof-inventory, house-style, competitors, sources, lessons, brand, or knowledge/<name>). Call with no file to list the files. Always read the relevant file instead of guessing the brand's voice, offers or numbers.",
    input: z.object({ file: z.string().max(120).optional().describe("File name, e.g. 'voice' or 'proof-inventory.yaml'. Omit to list files.") }),
    annotations: { readOnly: true, idempotent: true },
    handler: async ({ ws }, { file }) => {
      const dir = ws.paths.brand;
      if (!file) return { files: listBrandFiles(dir) };
      const path = brandFilePath(dir, file);
      if (!existsSync(path)) {
        throw new ToolError(`brand/${relative(dir, path)} doesn't exist yet.`, "Run /attention:init in Claude Code to create the Brand Kit, or `attentionos init`.");
      }
      const content = await readWorkspaceContent(ws.paths.root, relative(ws.paths.root, path));
      return { file: `brand/${relative(dir, path)}`, content: content.text };
    },
  });

  const appendLessonTool = defineTool({
    name: "core_append_lesson",
    description:
      "Save a correction as a dated rule in brand/lessons.md so every future run follows it. Use whenever the user corrects or rejects work. Write the rule as a short instruction (\"Never open with a question about price\") and quote the evidence (what was wrong). Duplicates are ignored.",
    input: z.object({
      rule: z.string().min(8).max(400).describe("The rule, as an instruction."),
      evidence: z.string().min(3).max(1000).describe("What happened: the rejected line, the note, the metric."),
      source: z.string().max(120).optional().describe("Where it came from, e.g. 'approval ap-7' or 'edit note rf-12 v2'."),
      scope: z.string().max(40).optional().describe("Area it applies to, e.g. 'scripting', 'editing', 'captions'."),
    }),
    annotations: { idempotent: true },
    handler: async ({ ws, actor }, input) => {
      const date = localDate(ws.now(), ws.config.workspace.timezone);
      const res = appendLesson(ws.paths.lessons, { ...input, actor, date });
      if (res.added) ws.reloadBrand();
      return { saved: res.added, duplicate: !res.added, file: "brand/lessons.md", entry: res.line.trim() };
    },
  });

  const requestApprovalTool = defineTool({
    name: "core_request_approval",
    description:
      "Put work in front of the user for approval (scripts, edits, posts, replies, spend). Nothing public happens until a person approves. Returns a short ref like ap-12 the user can answer to. A pending request for the same item is reused.",
    input: z.object({
      kind: z.enum(APPROVAL_KINDS),
      subjectType: z.string().min(1).max(40).describe("Table or thing being approved, e.g. 'content', 'posts', 'edit_jobs'."),
      subjectId: z.string().uuid().optional(),
      summary: z.string().min(3).max(300).describe("One plain sentence the user sees, e.g. 'Script for Thursday: three pricing myths'."),
      preview: z.record(z.string(), z.unknown()).optional().describe("Small JSON the approval card shows (hook, caption, file path)."),
    }),
    handler: async ({ ws, actor }, input) => {
      const agent = agentColumn(actor);
      const { approval, created } = await approvalCall(() =>
        requestApproval(ws.sql, ws.id, { ...input, agent, runId: info.runId ?? null }),
      );
      if (created) {
        await recordAgentEvent(ws.sql, {
          workspaceId: ws.id,
          agent,
          kind: "approval",
          runId: info.runId ?? null,
          message: `Asked for approval (${approval.ref}): ${approval.summary}`,
          data: { ref: approval.ref, kind: approval.kind },
        });
      }
      return { ...approvalView(approval), created };
    },
  });

  const listApprovalsTool = defineTool({
    name: "core_list_approvals",
    description: "List approval requests, oldest pending first by default.",
    input: z.object({
      status: z.enum([...APPROVAL_STATUSES, "all"]).default("pending"),
      kind: z.enum(APPROVAL_KINDS).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    annotations: { readOnly: true, idempotent: true },
    handler: async ({ ws }, input) => ({ approvals: (await listApprovals(ws.sql, ws.id, input)).map(approvalView) }),
  });

  const decideApprovalTool = defineTool({
    name: "core_decide_approval",
    description:
      "Record the user's decision on an approval (approved, rejected, or revised = asked for changes). Only call this when the user has clearly decided; agents can't approve their own work. After a rejection or revision with a note, also save the lesson with core_append_lesson.",
    input: z.object({
      ref: z.string().min(2).max(64).describe("The ref (ap-12) or id."),
      decision: z.enum(["approved", "rejected", "revised"]),
      note: z.string().max(2000).optional().describe("The user's words, verbatim when possible."),
    }),
    handler: async ({ ws, actor }, input) => {
      const row = await approvalCall(() => decideApproval(ws.sql, ws.id, { refOrId: input.ref, decision: input.decision, note: input.note, actor }));
      return {
        ...approvalView(row),
        next: input.decision === "approved" ? undefined : "If the note is a lasting preference, save it with core_append_lesson.",
      };
    },
  });

  const logProgress = defineTool({
    name: "core_log_progress",
    description:
      "Add a short progress line to the activity feed the user watches, in plain language about the work (\"Drafted 3 hooks for the FAQ reel\"), never internals.",
    input: z.object({
      message: z.string().min(2).max(500),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async ({ ws, actor }, input) => {
      await recordAgentEvent(ws.sql, {
        workspaceId: ws.id,
        agent: agentColumn(actor),
        kind: "progress",
        runId: info.runId ?? null,
        message: input.message,
        data: input.data ?? null,
      });
      return { logged: true };
    },
  });

  const readContent = defineTool({
    name: "core_read_content",
    description: "Read a workspace text content file or list a content directory (brand, scripts, captions, text-posts, media). Use instead of Read, Glob or Grep. Secrets, configuration, hidden files and symlinks are inaccessible. Listings return at most 200 entries; files at most 256 KB.",
    input: z.object({ path: z.string().min(1).max(1000) }),
    annotations: { readOnly: true },
    handler: async ({ ws }, { path }) => readWorkspaceContent(ws.paths.root, path),
  });
  return [status, brandKit, appendLessonTool, requestApprovalTool, listApprovalsTool, decideApprovalTool, logProgress, readContent] as unknown as ToolDefinition[];
}

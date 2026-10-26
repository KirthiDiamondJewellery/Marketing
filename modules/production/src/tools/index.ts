import { defineTool, ToolError, type ToolDefinition, type WorkspaceContext } from "@attentionos/core";
import { z } from "zod";
import { linkUpload } from "../repo.ts";

/** What's in production right now: takes waiting for a script, and every edit with its step. */
export async function productionQueue(ws: WorkspaceContext): Promise<Record<string, unknown>> {
  const uploads = await ws.sql<{ id: string; file_name: string; status: string; role: string | null; title: string | null; best: unknown; error: string | null }[]>`
    select u.id, u.file_name, u.status, u.role, c.title, u.candidates->0 as best, u.error
      from production_uploads u left join content c on c.id = u.content_id
     where u.workspace_id = ${ws.id} and u.status <> 'dismissed' and u.created_at > now() - interval '14 days'
     order by u.created_at desc limit 30`;
  const edits = await ws.sql<{ ref: string; status: string; version: number; title: string | null }[]>`
    select e.ref, e.status, e.version, c.title from edit_jobs e left join content c on c.id = e.content_id
     where e.workspace_id = ${ws.id} and e.status not in ('cancelled') and e.updated_at > now() - interval '14 days'
     order by e.created_at desc limit 30`;
  return {
    waitingForScript: uploads.filter((u) => u.status === "suggested" || u.status === "unmatched").map((u) => ({ uploadId: u.id, file: u.file_name, bestGuess: u.best, problem: u.error })),
    takes: uploads.filter((u) => u.status === "linked").map((u) => ({ file: u.file_name, script: u.title, role: u.role })),
    edits: edits.map((e) => ({ ref: e.ref, title: e.title, step: e.status, version: e.version })),
  };
}

export const productionTools: ToolDefinition[] = [
  defineTool({
    name: "production_queue",
    description: "What's in production: uploaded takes waiting for their script, takes already linked, and each edit with its current step.",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    handler: (ctx) => productionQueue(ctx.ws),
  }),
  defineTool({
    name: "production_link_upload",
    description: "File an uploaded take under its script (or none) and start the edit. A second take of a script that is already being edited is kept as an extra take.",
    input: z.object({
      uploadId: z.string().uuid(),
      contentId: z.string().uuid().nullable().describe("The script's content id, or null to edit it without a script."),
      replace: z.boolean().optional().describe("Edit this take instead of the one already being edited."),
    }),
    handler: async (ctx, input) => {
      try {
        return await linkUpload(ctx.ws, { uploadId: input.uploadId, contentId: input.contentId, actor: ctx.actor, replace: input.replace ?? false });
      } catch (err) {
        throw new ToolError((err as Error).message, "List uploads with production_queue.");
      }
    },
  }),
] as ToolDefinition[];

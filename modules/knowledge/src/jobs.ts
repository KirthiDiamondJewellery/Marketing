import { z } from "zod";
import { defineNativeJob } from "@attentionos/core";
import { indexPath, indexWorkspace, SOURCE_TYPES, type IndexWorkspaceResult } from "@attentionos/knowledge";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One plain line for the activity stream: what changed, not how. */
export function describeIndexRun(r: IndexWorkspaceResult): string {
  if (r.skipped) return r.skipped;
  const parts = [`Checked ${plural(r.sources, "source")}`];
  if (r.updated) parts.push(`${r.updated} new or changed`);
  else parts.push("nothing changed");
  if (r.embedded) parts.push(`${plural(r.embedded, "passage")} embedded`);
  if (r.staleDeleted) parts.push(`${plural(r.staleDeleted, "old passage")} removed`);
  let line = parts.join(", ");
  if (r.embedWarning) line += `. Keyword search only for now: ${r.embedWarning}`;
  return line;
}

export const indexWorkspaceJob = defineNativeJob({
  kind: "native",
  id: "knowledge.index-workspace",
  agent: "analyst",
  description: "Updates the knowledge store with what changed in your Brand Kit, posts, scripts and research.",
  input: z.object({
    /** Only these source types, e.g. ["brand_doc", "lesson"]. Default: everything. */
    sources: z.array(z.enum(SOURCE_TYPES)).optional(),
    /** Only these Brand Kit files (paths inside brand/). */
    paths: z.array(z.string().min(1)).max(200).optional(),
  }),
  timeoutMs: 30 * 60_000,
  async run(ctx) {
    const r = await indexWorkspace(ctx.ws, { sources: ctx.input.sources, paths: ctx.input.paths });
    await ctx.progress(describeIndexRun(r), { sources: r.sources, updated: r.updated, embedded: r.embedded });
    return r;
  },
});

export const indexPathJob = defineNativeJob({
  kind: "native",
  id: "knowledge.index-path",
  agent: "analyst",
  description: "Re-reads one Brand Kit file into the knowledge store right after it changes.",
  input: z.object({ path: z.string().min(1) }),
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const r = await indexPath(ctx.ws, ctx.input.path);
    await ctx.progress(r.staleDeleted && !r.sources ? `Removed ${ctx.input.path} from the knowledge store` : `Updated ${ctx.input.path} in the knowledge store`);
    return r;
  },
});

export const KNOWLEDGE_JOBS = [indexWorkspaceJob, indexPathJob];

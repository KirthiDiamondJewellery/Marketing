"use server";

import { requireSession } from "@/server/auth";
import { refresh } from "next/cache";
import { writeScriptsAction } from "@/server/actions/film";
import { remixOutlier, type ActionResult } from "@/server/actions/research";
import { enqueueRun, recordAgentEvent } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { id as idSchema, parse } from "@/server/validate";

/**
 * "Remix this" on a proven post (a competitor's outlier or one of your own breakouts): it becomes an idea credited to
 * the source post, and the Copywriter remakes it closely (same hook, beats and format; your topic, proof and words), so
 * it shows up in Scripts. Remixing the same post twice reuses the first idea.
 */
export async function remixToScriptAction(externalPostId: string): Promise<ActionResult<{ id: string; title: string }>> {
  await requireSession();
  if (!parse(idSchema, externalPostId)) return { ok: false, error: "That post isn't in your research any more." };
  const ws = workspace();
  const [existing] = await ws.sql<{ id: string; title: string }[]>`
    select id, title from content
     where workspace_id = ${ws.id} and status <> 'archived'
       and exists (select 1 from jsonb_array_elements(source_refs) s where s ->> 'type' = 'external_post' and s ->> 'id' = ${externalPostId})
     limit 1`;
  if (existing) return { ok: true, message: `Already in Scripts: ${existing.title}`, data: existing };
  const made = await remixOutlier(externalPostId);
  if (!made.ok || !made.data) return made;
  const data = { id: made.data.id, title: made.data.title };
  if (!made.data.blueprintReady) {
    // The Copywriter remakes the post from its checked teardown. Tear it down first; the script starts as soon as
    // the teardown is in, or after WAIT_MINUTES either way.
    const contentId = made.data.id;
    await enqueueRun(ws.sql, {
      workspaceId: ws.id, jobId: "scripting.write-script", agent: "copywriter", input: { contentId }, trigger: "manual",
      createdBy: "user:studio", dedupeKey: `write-script:${contentId}`, runAfter: new Date(Date.now() + WAIT_MINUTES * 60_000),
    });
    await enqueueRun(ws.sql, {
      workspaceId: ws.id, jobId: "research.teardown-prep", agent: "analyst", trigger: "manual", createdBy: "user:studio",
      input: { externalPostId, reuseBlueprint: true, then: { jobId: "scripting.remix-ready", agent: "copywriter", input: { contentId } } },
      dedupeKey: `teardown-prep:${externalPostId}:${contentId}`,
    });
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: "user:studio", kind: "handoff", message: `Asked for a teardown of the source post, then a script: “${data.title}”`, data: { to: "analyst", contentId } });
    refresh();
    return { ok: true, message: `Added to Scripts. Breaking down the source post first; the Copywriter starts "${data.title}" right after.`, data };
  }
  const queued = await writeScriptsAction([made.data.id]);
  refresh();
  return {
    ok: true,
    message: queued.ok ? `Added to Scripts. The Copywriter is remaking it: "${data.title}".` : `Added "${data.title}" to Scripts as an idea.`,
    data,
  };
}

/** How long a remix script waits for its source's teardown before it starts anyway. */
const WAIT_MINUTES = 30;

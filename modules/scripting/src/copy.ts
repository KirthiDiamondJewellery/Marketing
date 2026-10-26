import { jsonb, ToolError, type Actor, type Sql, type WorkspaceContext } from "@attentionos/core";
import { mergeBanned, parseBannedFromVoiceMd, validateCaptions, validateTextPost, type ValidationResult } from "@attentionos/guardrails";
import { getContent, getContentKeyword, latestScript } from "./db.ts";
import { captionPlatforms, requestApproval, storedReport } from "./service.ts";

/** Captions from a transcript, and the weekly text-post batch. */

function brandBanned(ws: WorkspaceContext) {
  const kit = ws.brand();
  return mergeBanned({ phrases: kit.brand.bannedPhrases }, parseBannedFromVoiceMd(kit.docs.voice ?? ""));
}

export async function saveCaptions(ws: WorkspaceContext, actor: Actor, input: { contentId: string; captions: unknown }): Promise<{ saved: boolean; report: ValidationResult; version: number | null }> {
  const content = await getContent(ws, input.contentId);
  if (!content) throw new ToolError(`No content item with id ${input.contentId} in this workspace.`);
  const latest = await latestScript(ws, content.id);
  if (!latest) throw new ToolError("This content has no script yet, so there's nowhere to attach captions.", "Write and save the script first.");
  const keyword = await getContentKeyword(ws, content.id);
  const kit = ws.brand();
  const report = validateCaptions(input.captions, {
    ctaType: (content.cta_type ?? kit.brand.cta.primary) as Parameters<typeof validateCaptions>[1]["ctaType"],
    keyword: keyword?.word ?? null,
    platforms: captionPlatforms(ws),
    bannedPhrases: brandBanned(ws).phrases,
    hashtagPool: kit.brand.hashtagPool,
  });
  if (!report.ok) return { saved: false, report, version: latest.version };
  const prev = latest.validator_report ?? {};
  await ws.sql`
    update scripts set captions = ${jsonb(ws.sql, input.captions)},
                       validator_report = ${jsonb(ws.sql, { ...prev, captions: storedReport(report, ws.now()), captionsBy: actor })}
     where workspace_id = ${ws.id} and id = ${latest.id}`;
  return { saved: true, report, version: latest.version };
}

export type TextPostInput = { platform: "x" | "threads" | "linkedin"; title?: string; text: string; hashtags?: string[]; rubric?: Record<string, number>; hasVisual?: boolean };

export async function saveTextPosts(
  ws: WorkspaceContext,
  actor: Actor,
  input: { weekOf: string; posts: TextPostInput[]; runId?: string | null },
): Promise<{ results: { index: number; platform: string; saved: boolean; contentId: string | null; approvalRef: string | null; report: ValidationResult }[] }> {
  const banned = brandBanned(ws);
  const kit = ws.brand();
  const results = [];
  for (const [index, post] of input.posts.entries()) {
    const report = validateTextPost(post, { bannedPhrases: banned.phrases, hashtagPool: kit.brand.hashtagPool });
    if (!report.ok) {
      results.push({ index, platform: post.platform, saved: false, contentId: null, approvalRef: null, report });
      continue;
    }
    const title = post.title?.trim() || `${post.platform === "linkedin" ? "LinkedIn post" : post.platform === "x" ? "X post" : "Threads post"}, week of ${input.weekOf}: ${post.text.split(/\n/)[0]!.slice(0, 60)}`;
    const saved = await ws.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const c = await sql<{ id: string }[]>`
        insert into content (workspace_id, title, status, kind, brief, created_by)
        values (${ws.id}, ${title}, 'scripted', ${post.platform === "linkedin" ? "longform" : "text"},
                ${jsonb(sql, { weekOf: input.weekOf, platform: post.platform, rubric: post.rubric ?? null })}, ${actor})
        returning id`;
      const contentId = c[0]!.id;
      const s = await sql<{ id: string }[]>`
        insert into scripts (workspace_id, content_id, version, body, captions, validator_report, status, created_by)
        values (${ws.id}, ${contentId}, 1, ${post.text}, ${jsonb(sql, { [post.platform]: { text: post.text, hashtags: post.hashtags ?? [] } })},
                ${jsonb(sql, storedReport(report, ws.now()))}, 'draft', ${actor})
        returning id`;
      const approvalRef = await requestApproval(ws, sql, {
        kind: "post",
        subjectType: "script",
        subjectId: s[0]!.id,
        summary: `Text post ready for review: ${title}`,
        preview: { contentId, platform: post.platform, text: post.text.slice(0, 280) },
        runId: input.runId ?? null,
      });
      return { contentId, approvalRef };
    });
    results.push({ index, platform: post.platform, saved: true, contentId: saved.contentId, approvalRef: saved.approvalRef, report });
  }
  return { results };
}

"use server";

import { requireSession } from "@/server/auth";
import { refresh } from "next/cache";
import type { Sql } from "@attentionos/core";
import { enqueueRun, recordAgentEvent } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { decideApprovalAction, type ActionResult } from "./approvals";
import { newIdeaAction } from "./film";
import { z } from "zod";
import { BAD_REQUEST, id as idSchema, parse, text as textSchema } from "@/server/validate";

/**
 * The Scripts page: ask the AI for a script, write one yourself, edit one, tell the AI what to change, approve, delete.
 * Scripts the owner writes or edits are saved as their own approved version (created_by user:studio). The script
 * validator isn't run on them (it lives with the Copywriter's tools): the version is marked as written by the owner
 * instead of claiming it passed the checks.
 */

const ACTOR = "user:studio";
const WRITE_SCRIPT = "scripting.write-script";

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** A short working title from what the owner typed: the first line or sentence, cut at a word. */
function titleFrom(text: string): string {
  const first = oneLine(text.split(/\n/).find((l) => l.trim()) ?? "");
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  let t = sentence.replace(/^(write|make|do|give me|i want|can you write|please write)\s+(me\s+)?(a\s+)?(script|reel|video)?\s*(about|on)?\s*/i, "").replace(/[.!?]+$/, "");
  if (t.length < 4) t = sentence;
  if (t.length > 80) t = `${t.slice(0, 80).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Validator report for a version the owner wrote: honest about the checks not having run. */
function ownerReport() {
  return { ok: null, errors: [], warnings: [], checkedAt: new Date().toISOString(), validator: "not run: written by the owner", userWritten: true };
}

/** Spoken body with the hook as its first line, and simple beats (hook, then the rest). */
function compose(hook: string, rest: string): { body: string; beats: { role: string; text: string }[] } {
  const r = rest.trim();
  const h = oneLine(hook);
  const startsWithHook = h && r.toLowerCase().startsWith(h.toLowerCase());
  const body = h && !startsWithHook ? `${h}\n\n${r}` : r || h;
  const tail = startsWithHook ? r.slice(h.length).trim() : r;
  const beats = [...(h ? [{ role: "hook", text: h }] : []), ...(tail ? [{ role: "close", text: tail }] : [])];
  return { body, beats };
}

/** "Ask the AI": what the owner wants becomes an idea (title from the first line, the full text as notes) and the Copywriter writes it. */
export async function askForScriptAction(text: string): Promise<ActionResult & { id?: string }> {
  await requireSession();
  if (parse(textSchema(), text) === undefined) return { ok: false, error: BAD_REQUEST };
  const ask = clean(text, 1000);
  if (ask.length < 8) return { ok: false, error: "Say a little more about what you want the script to be about." };
  const r = await newIdeaAction({ title: titleFrom(ask), notes: ask });
  if (!r.ok) return r;
  return { ok: true, id: r.id, message: "The AI is writing it. It shows up here for your OK." };
}

/** "Write it myself": saved straight away as an approved script, ready to film. */
const ownScriptInput = z.object({ title: textSchema(2000).optional(), hook: textSchema(4000).optional(), body: textSchema(40_000).optional() });

export async function createOwnScriptAction(raw: { title?: string; hook?: string; body?: string }): Promise<ActionResult & { id?: string }> {
  await requireSession();
  const input = parse(ownScriptInput, raw);
  if (!input) return { ok: false, error: "The script is too long or incomplete. Shorten it and try again." };
  const title = oneLine(clean(input.title, 200));
  const hook = oneLine(clean(input.hook, 400));
  const rest = clean(input.body, 8000);
  if (title.length < 3) return { ok: false, error: "Give it a title (a few words)." };
  if (title.length > 140) return { ok: false, error: "Keep the title under 140 characters." };
  if (!rest && !hook) return { ok: false, error: "Write the script first." };
  const { body, beats } = compose(hook, rest);
  const ws = workspace();
  try {
    const id = await ws.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const [row] = await sql<{ id: string }[]>`
        insert into content (workspace_id, title, status, kind, source_refs, brief, created_by)
        values (${ws.id}, ${title}, 'scripted', 'reel', ${sql.json([{ type: "manual" }] as never)},
                ${sql.json({ header: title, kind: "talking_head", source: "studio", writtenBy: "owner" } as never)}, ${ACTOR})
        returning id`;
      await sql`
        insert into scripts (workspace_id, content_id, version, body, beats, hook_text, hook_source, claim_ledger, validator_report, status, created_by)
        values (${ws.id}, ${row!.id}, 1, ${body}, ${sql.json(beats as never)}, ${hook || null},
                ${sql.json({ hook_id: null, pattern: null, origin: "manual", ref: null } as never)}, ${sql.json([] as never)},
                ${sql.json(ownerReport() as never)}, 'approved', ${ACTOR})`;
      return row!.id;
    });
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: `Wrote a script: “${title}”`, data: { contentId: id } });
    refresh();
    return { ok: true, id, message: "Saved. It's ready to film." };
  } catch (e) {
    console.error("[studio] create script failed:", e);
    return { ok: false, error: "Couldn't save the script. Check the database connection and try again." };
  }
}

type Latest = { content_status: string; title: string; script_id: string | null; version: number | null; script_status: string | null; captions: unknown; approval_id: string | null; writing: boolean };

async function latest(contentId: string): Promise<Latest | null> {
  const ws = workspace();
  const [row] = await ws.sql<Latest[]>`
    select c.status as content_status, c.title, s.id as script_id, s.version, s.status as script_status, s.captions,
           (select a.id from approvals a where a.workspace_id = c.workspace_id and a.status = 'pending' and a.kind = 'script'
              and a.subject_type = 'script' and a.subject_id = s.id order by a.requested_at desc limit 1) as approval_id,
           exists (select 1 from agent_runs r where r.workspace_id = c.workspace_id and r.job_id = ${WRITE_SCRIPT}
                     and r.status in ('queued', 'running') and r.input ->> 'contentId' = c.id::text) as writing
      from content c
      left join lateral (
        select id, version, status, captions from scripts
         where workspace_id = c.workspace_id and content_id = c.id and status in ('draft', 'approved')
         order by version desc limit 1
      ) s on true
     where c.workspace_id = ${ws.id} and c.id = ${contentId}`;
  return row ?? null;
}

/** "Edit it yourself": the owner's hook and body become the next version, approved (it's their own words). */
export async function saveOwnEditAction(contentId: string, raw: { hook?: string; body?: string }): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, contentId)) return { ok: false, error: "Unknown script." };
  const input = parse(ownScriptInput.omit({ title: true }), raw);
  if (!input) return { ok: false, error: "The script is too long. Shorten it and try again." };
  const hook = oneLine(clean(input.hook, 400));
  const rest = clean(input.body, 8000);
  if (!rest && !hook) return { ok: false, error: "The script can't be empty." };
  const cur = await latest(contentId);
  if (!cur || !["idea", "scripted", "filming"].includes(cur.content_status)) return { ok: false, error: "That script can't be edited any more." };
  if (cur.writing) return { ok: false, error: "The AI is rewriting this one right now. Edit it when it's back." };
  const { body, beats } = compose(hook, rest);
  const ws = workspace();
  try {
    const version = await ws.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const [row] = await sql<{ id: string; version: number }[]>`
        insert into scripts (workspace_id, content_id, version, body, beats, hook_text, hook_source, claim_ledger, validator_report, captions, status, created_by)
        values (${ws.id}, ${contentId},
                (select coalesce(max(version), 0) + 1 from scripts where workspace_id = ${ws.id} and content_id = ${contentId}),
                ${body}, ${sql.json(beats as never)}, ${hook || null},
                ${sql.json({ hook_id: null, pattern: null, origin: "manual", ref: null } as never)}, ${sql.json([] as never)},
                ${sql.json(ownerReport() as never)}, ${cur.captions ? sql.json(cur.captions as never) : null}, 'approved', ${ACTOR})
        returning id, version`;
      await sql`update scripts set status = 'superseded'
                 where workspace_id = ${ws.id} and content_id = ${contentId} and id <> ${row!.id} and status in ('draft', 'approved')`;
      // The version that was waiting for an OK is replaced by this one (system bookkeeping: no rewrite is queued).
      await sql`
        update approvals set status = 'revised', decided_at = now(), decided_by = 'system', decision_note = 'The owner edited the script and approved their version.'
         where workspace_id = ${ws.id} and status = 'pending' and kind = 'script' and subject_type = 'script' and preview ->> 'contentId' = ${contentId}`;
      await sql`update content set status = case when status = 'idea' then 'scripted' else status end, updated_at = now()
                 where workspace_id = ${ws.id} and id = ${contentId}`;
      return row!.version;
    });
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: `Edited “${cur.title}” (version ${version})`, data: { contentId } });
    refresh();
    return { ok: true, message: "Saved your version. It's ready to film." };
  } catch (e) {
    console.error("[studio] save script edit failed:", e);
    return { ok: false, error: "Couldn't save your changes. Check the database connection and try again." };
  }
}

/**
 * "Tell the AI what to change". A version waiting for your OK is sent back with the notes (the approvals trigger queues
 * the rewrite). Otherwise (already approved, filmed, or a draft nobody was asked to OK) the Copywriter is queued
 * directly with the same revise input the trigger uses; the new version comes back for your OK and replaces the
 * approved one only when you approve it.
 */
export async function reviseScriptAction(contentId: string, notes: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, contentId)) return { ok: false, error: "Unknown script." };
  if (parse(textSchema(), notes) === undefined) return { ok: false, error: BAD_REQUEST };
  const text = clean(notes, 2000);
  if (!text) return { ok: false, error: "Say what you'd like changed so the AI knows what to fix." };
  const cur = await latest(contentId);
  if (!cur || !["idea", "scripted", "filming"].includes(cur.content_status)) return { ok: false, error: "That script can't be changed any more." };
  if (cur.writing) return { ok: true, message: "The AI is already working on this one." };
  if (cur.approval_id) {
    const r = await decideApprovalAction(cur.approval_id, "revised", text);
    if (!r.ok) return r;
    refresh();
    return { ok: true, message: "Rewriting with your notes. The new version comes back here for your OK." };
  }
  const ws = workspace();
  try {
    const revise = { notes: text, ...(cur.version ? { fromVersion: cur.version } : {}) };
    const r = await enqueueRun(ws.sql, {
      workspaceId: ws.id,
      jobId: WRITE_SCRIPT,
      agent: "copywriter",
      input: { contentId, revise },
      trigger: "manual",
      createdBy: ACTOR,
      dedupeKey: `write-script:${contentId}:revise:studio:${Date.now().toString(36)}`,
    });
    if (r.deduped) return { ok: true, message: "The AI is already working on this one." };
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id,
      agent: ACTOR,
      kind: "handoff",
      message: cur.version ? `Asked the Copywriter for version ${cur.version + 1} of “${cur.title}”` : `Asked the Copywriter to rewrite “${cur.title}”`,
      data: { to: "copywriter", contentId, fromVersion: cur.version },
    });
    refresh();
    return { ok: true, message: "Rewriting with your notes. The new version comes back here for your OK." };
  } catch (e) {
    console.error("[studio] revise script failed:", e);
    return { ok: false, error: "Couldn't ask the AI. Check the database connection and try again." };
  }
}

/**
 * Approve the newest version. One with a pending approval is decided there (the approvals trigger moves it to ready);
 * a passing draft nobody was asked to OK is approved directly, the same way the trigger would.
 */
export async function approveScriptAction(contentId: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, contentId)) return { ok: false, error: "Unknown script." };
  const cur = await latest(contentId);
  if (!cur?.script_id || cur.script_status !== "draft") return { ok: false, error: "That script was already decided." };
  if (cur.approval_id) {
    const r = await decideApprovalAction(cur.approval_id, "approved");
    if (!r.ok) return r;
  } else {
    const ws = workspace();
    const done = await ws.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const rows = await sql`
        update scripts set status = 'approved'
         where workspace_id = ${ws.id} and id = ${cur.script_id} and status = 'draft' and (validator_report ->> 'ok')::boolean is true
        returning id`;
      if (!rows.length) return false;
      await sql`update scripts set status = 'superseded'
                 where workspace_id = ${ws.id} and content_id = ${contentId} and id <> ${cur.script_id} and status in ('draft', 'approved')`;
      await sql`update content set status = 'scripted', updated_at = now() where workspace_id = ${ws.id} and id = ${contentId} and status = 'idea'`;
      return true;
    });
    if (!done) return { ok: false, error: "This draft didn't pass every check. Edit it or tell the AI what to change." };
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: `Approved the script “${cur.title}”`, data: { contentId } });
  }
  refresh();
  return { ok: true, message: "Approved. It's ready to film." };
}

/**
 * "Delete": the piece is archived (it leaves every list), any version waiting for an OK is rejected and queued
 * rewrites are cancelled. The rows stay in the database.
 */
export async function deleteScriptAction(contentId: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, contentId)) return { ok: false, error: "Unknown script." };
  const ws = workspace();
  try {
    const title = await ws.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const [c] = await sql<{ title: string }[]>`
        select title from content where workspace_id = ${ws.id} and id = ${contentId} and status in ('idea', 'scripted', 'filming') for update`;
      if (!c) return null;
      // Reject first (its trigger may move the piece back to an idea), then archive.
      await sql`
        update approvals set status = 'rejected', decided_at = now(), decided_by = ${ACTOR}, decision_note = 'Deleted from Scripts.'
         where workspace_id = ${ws.id} and status = 'pending' and kind = 'script' and subject_type = 'script'
           and subject_id in (select id from scripts where workspace_id = ${ws.id} and content_id = ${contentId})`;
      await sql`
        update agent_runs set status = 'cancelled', finished_at = now(), error = 'The script was deleted.'
         where workspace_id = ${ws.id} and job_id = ${WRITE_SCRIPT} and status = 'queued' and input ->> 'contentId' = ${contentId}`;
      await sql`
        update content set status = 'archived', brief = coalesce(brief, '{}'::jsonb) || ${sql.json({ deleted: { by: ACTOR, at: new Date().toISOString() } } as never)}, updated_at = now()
         where workspace_id = ${ws.id} and id = ${contentId}`;
      return c.title;
    });
    if (!title) return { ok: false, error: "That script is already gone or in the edit." };
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: `Deleted the script “${title}”`, data: { contentId } });
    refresh();
    return { ok: true, message: "Deleted." };
  } catch (e) {
    console.error("[studio] delete script failed:", e);
    return { ok: false, error: "Couldn't delete it. Check the database connection and try again." };
  }
}

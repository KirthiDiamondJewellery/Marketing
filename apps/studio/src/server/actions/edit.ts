"use server";

import { requireSession } from "@/server/auth";
import { refresh } from "next/cache";
import { recordAgentEvent } from "@attentionos/db";
import { upsertRelease } from "@attentionos/module-production/repo";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, captions as captionsSchema, parse, platforms as platformsSchema } from "@/server/validate";
import { approveVideoAction, scheduleReadyAction, type ActionResult } from "./approvals";

/**
 * "Looks good" on the Edit page: approve a finished video and then schedule it (next open slot or a picked time),
 * download it, or keep it as Ready to post. Every path approves first; a video that's approved and not scheduled
 * waits in Calendar under Ready to post.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LooksGoodChoice = { then: "next" } | { then: "at"; at: string } | { then: "download" } | { then: "ready" };
export type LooksGoodResult = ActionResult & { releaseId?: string | null; assetId?: string | null; downloadUrl?: string | null };

const looksGoodInput = z.object({
  approvalId: z.string().max(64),
  choice: z.discriminatedUnion("then", [
    z.object({ then: z.literal("next") }),
    z.object({ then: z.literal("at"), at: z.string().max(64) }),
    z.object({ then: z.literal("download") }),
    z.object({ then: z.literal("ready") }),
  ]),
  opts: z.object({ captions: captionsSchema.optional(), platforms: platformsSchema.optional() }),
});

type Found = { edit_id: string; ref: string; version: number; content_id: string | null; title: string | null; output_asset_id: string | null };

async function videoFor(approvalId: string): Promise<Found | null> {
  const ws = workspace();
  const [row] = await ws.sql<Found[]>`
    select e.id as edit_id, e.ref, e.version, e.content_id, c.title, e.output_asset_id
      from approvals a join edit_jobs e on e.id = a.subject_id and e.workspace_id = a.workspace_id
      left join content c on c.id = e.content_id
     where a.workspace_id = ${ws.id} and a.id = ${approvalId}`;
  return row ?? null;
}

async function releaseFor(v: Found): Promise<string | null> {
  const ws = workspace();
  try {
    const [r] = await ws.sql<{ id: string }[]>`select id from production_releases where workspace_id = ${ws.id} and edit_job_id = ${v.edit_id} and version = ${v.version}`;
    return r?.id ?? null;
  } catch (e) {
    // Best effort: the approval already went through; without the id the page just can't link to the release.
    console.error("[studio] looking up the release failed:", e);
    return null;
  }
}

function downloadHref(assetId: string, title: string | null): string {
  const name = (title ?? "video").replace(/[^\w .-]+/g, "").trim().slice(0, 80) || "video";
  return `/api/media/${assetId}?download=1&name=${encodeURIComponent(name)}`;
}

export async function looksGoodAction(
  rawApprovalId: string,
  rawChoice: LooksGoodChoice,
  rawOpts: { captions?: Record<string, string>; platforms?: string[] } = {},
): Promise<LooksGoodResult> {
  await requireSession();
  const args = parse(looksGoodInput, { approvalId: rawApprovalId, choice: rawChoice, opts: rawOpts ?? {} });
  if (!args) return { ok: false, error: BAD_REQUEST };
  const { approvalId, choice, opts } = args;
  if (!UUID.test(approvalId)) return { ok: false, error: "Unknown video." };
  const v = await videoFor(approvalId);
  if (!v) return { ok: false, error: "Unknown video." };

  if (choice.then === "at") {
    const t = Date.parse(choice.at);
    if (!Number.isFinite(t)) return { ok: false, error: "Pick a valid date and time." };
    if (t < Date.now() + 10 * 60_000) return { ok: false, error: "Pick a time at least 10 minutes from now." };
  }
  if (opts.platforms && !opts.platforms.length && (choice.then === "next" || choice.then === "at")) return { ok: false, error: "Pick at least one platform to post on." };

  if (choice.then === "next") {
    // No posting plan yet (the editor proposes one when it finishes): plan the platforms picked here, next open slot each.
    if (opts.platforms?.length) {
      const ws = workspace();
      // If the plan can't be saved, stop before approving: otherwise the video would go out without the platforms picked here.
      try {
        const [existing] = await ws.sql<{ n: number }[]>`
          select coalesce(jsonb_array_length(slots), 0)::int as n from production_releases where workspace_id = ${ws.id} and edit_job_id = ${v.edit_id} and version = ${v.version}`;
        if (!existing?.n) {
          const igAuto = ((ws.config.modules.publishing?.settings ?? {}) as { instagram?: { autopost?: boolean } }).instagram?.autopost === true;
          const slots = opts.platforms.map((platform) => ({ platform, scheduledAt: null, mode: platform === "instagram" && !igAuto ? ("assist" as const) : ("auto" as const) }));
          await upsertRelease(ws, { editJobId: v.edit_id, contentId: v.content_id, version: v.version, slots });
        }
      } catch (e) {
        console.error("[studio] saving the posting plan failed:", e);
        return { ok: false, error: "Couldn't save the platforms you picked, so nothing was approved yet. Check the database connection and try again." };
      }
    }
    const r = await approveVideoAction(approvalId, { captions: opts.captions, platforms: opts.platforms, then: "schedule" });
    refresh();
    if (!r.ok) return r;
    return { ok: true, message: "Approved. Scheduling it at the next open slot on each platform.", releaseId: await releaseFor(v), assetId: v.output_asset_id };
  }

  const r = await approveVideoAction(approvalId, { captions: opts.captions, ...(opts.platforms?.length ? { platforms: opts.platforms } : {}), then: "ready" });
  if (!r.ok) {
    refresh();
    return r;
  }
  const releaseId = await releaseFor(v);

  if (choice.then === "at") {
    if (!releaseId) {
      refresh();
      return { ok: false, error: "Approved and saved as ready, but it couldn't be scheduled. Schedule it from Calendar under Ready to post." };
    }
    const s = await scheduleReadyAction(releaseId, { platforms: opts.platforms, at: new Date(Date.parse(choice.at)).toISOString() });
    refresh();
    if (!s.ok) return { ok: false, error: `Approved and saved as ready, but it couldn't be scheduled: ${s.error} It's in Calendar under Ready to post.`, releaseId };
    return { ok: true, message: s.message ?? "Scheduled.", releaseId, assetId: v.output_asset_id };
  }

  if (choice.then === "download") {
    const ws = workspace();
    if (v.output_asset_id) {
      await recordAgentEvent(ws.sql, {
        workspaceId: ws.id,
        agent: "user:studio",
        kind: "progress",
        message: `Downloaded “${v.title ?? "a video"}”`,
        data: { kind: "edit.download", editId: v.edit_id, ref: v.ref, version: v.version, releaseId, assetId: v.output_asset_id },
      });
    }
    refresh();
    return {
      ok: true,
      message: v.output_asset_id ? "Downloading. It also waits in Calendar under Ready to post." : "Approved, but the video file is missing. It's in Calendar under Ready to post.",
      releaseId,
      assetId: v.output_asset_id,
      downloadUrl: v.output_asset_id ? downloadHref(v.output_asset_id, v.title) : null,
    };
  }

  refresh();
  return { ok: true, message: "Saved. It's in Calendar under Ready to post.", releaseId, assetId: v.output_asset_id };
}

/** Marks a later download of an approved video so Recently done can say "Downloaded". */
export async function markDownloadedAction(rawEditId: string): Promise<ActionResult> {
  await requireSession();
  const editId = parse(z.string().regex(UUID), rawEditId);
  if (!editId) return { ok: false, error: "Unknown video." };
  const ws = workspace();
  const [e] = await ws.sql<{ id: string; ref: string; version: number; title: string | null; output_asset_id: string | null }[]>`
    select e.id, e.ref, e.version, c.title, e.output_asset_id from edit_jobs e left join content c on c.id = e.content_id where e.workspace_id = ${ws.id} and e.id = ${editId}`;
  if (!e) return { ok: false, error: "Unknown video." };
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "user:studio",
    kind: "progress",
    message: `Downloaded “${e.title ?? "a video"}”`,
    data: { kind: "edit.download", editId: e.id, ref: e.ref, version: e.version, assetId: e.output_asset_id },
  });
  return { ok: true };
}

import type { WorkspaceContext } from "@attentionos/core";
import { activity, getSetting, setSetting } from "./gate.ts";
import { getPost } from "./repo.ts";
import { localDate } from "./time.ts";

/**
 * The one-time trial-reel proof lock, per Instagram account (ADR-14). A wrong setting would put every trial variation
 * on the main grid, so full trial-reel batches stay locked until a person has checked that one live trial reel stayed
 * off the grid. The lock lives in the workspace `settings` table, keyed by the account; it is never shipped and never
 * copied between accounts. The trial-reels module reads it before scheduling a batch.
 */

export const proofKey = (accountId: string) => `publishing.trial_reels.proof:${accountId}`;
export type ProofLock = { date: string; postId: string; confirmedAt: string; confirmedBy: string; shortcode?: string | null };

export async function getTrialProof(ws: WorkspaceContext, providerAccountId: string): Promise<ProofLock | undefined> {
  return getSetting<ProofLock>(ws, proofKey(providerAccountId));
}

/** Writes the one-time proof lock after the user checked that a live trial reel stayed off the main grid. */
export async function confirmTrialProof(ws: WorkspaceContext, postId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  if (actor.startsWith("agent:")) return { ok: false, message: "Only a person can confirm the trial-reel check." };
  const post = await getPost(ws, postId);
  if (!post || !post.is_trial) return { ok: false, message: "That isn't a trial reel." };
  if (post.status !== "published") return { ok: false, message: "That trial reel isn't live yet. Confirm once it's posted." };
  const [acct] = await ws.sql<{ provider_account_id: string }[]>`select provider_account_id from social_accounts where workspace_id = ${ws.id} and id = ${post.social_account_id}`;
  if (!acct) return { ok: false, message: "Couldn't find the account for that post." };
  const shortcode = post.url?.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
  const lock: ProofLock = { date: localDate(ws.now(), ws.config.workspace.timezone), postId, confirmedAt: ws.now().toISOString(), confirmedBy: actor, shortcode };
  await setSetting(ws, proofKey(acct.provider_account_id), lock);
  await activity(ws, "publisher", "Trial reels confirmed working on this account; full batches are unlocked", { postId });
  return { ok: true, message: "Thanks. Trial reels are unlocked for this account. Redo this check if your publisher changes how trial reels work." };
}

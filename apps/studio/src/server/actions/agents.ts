"use server";

import { requireSession } from "@/server/auth";
import { AGENT_MONOGRAMS, AUTONOMY_LEVELS, type AgentKey, type AutonomyLevel } from "@attentionos/core";
import { recordAgentEvent } from "@attentionos/db";
import { refresh } from "next/cache";
import { AGENT_INFO, isAgentKey } from "@/components/agents/meta";
import { AUTONOMY_LABEL } from "@/components/shell/format";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, key as keySchema, parse } from "@/server/validate";
import type { ActionResult } from "./approvals";

const ACTOR = "user:studio";

/** Writes one column of the agent row, creating the row if the workspace never stored one. */
async function upsertAgent(key: AgentKey, patch: { autonomy?: AutonomyLevel; enabled?: boolean; model?: string | null }) {
  const ws = workspace();
  const sql = ws.sql;
  const name = AGENT_INFO[key].name;
  const cfg = ws.config.agents?.[key];
  await sql`
    insert into agents (workspace_id, key, name, monogram, autonomy, enabled, model, updated_at)
    values (${ws.id}, ${key}, ${name}, ${AGENT_MONOGRAMS[key]}, ${patch.autonomy ?? cfg?.autonomy ?? "review_all"},
            ${patch.enabled ?? cfg?.enabled ?? true}, ${patch.model === undefined ? cfg?.model ?? null : patch.model}, now())
    on conflict (workspace_id, key) do update set
      autonomy = ${patch.autonomy === undefined ? sql`agents.autonomy` : patch.autonomy},
      enabled = ${patch.enabled === undefined ? sql`agents.enabled` : patch.enabled},
      model = ${patch.model === undefined ? sql`agents.model` : patch.model},
      updated_at = now()`;
}

async function note(message: string, agent: AgentKey, data: Record<string, unknown>) {
  const ws = workspace();
  await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message, data: { ...data, agent } });
}

export async function setAutonomyAction(key: string, level: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(z.object({ key: keySchema, level: keySchema }), { key, level })) return { ok: false, error: BAD_REQUEST };
  if (!isAgentKey(key)) return { ok: false, error: "Unknown agent." };
  if (!(AUTONOMY_LEVELS as readonly string[]).includes(level)) return { ok: false, error: "Unknown autonomy level." };
  const lvl = level as AutonomyLevel;
  await upsertAgent(key, { autonomy: lvl });
  await note(`Set ${AGENT_INFO[key].name} to ${AUTONOMY_LABEL[lvl].toLowerCase()}`, key, { autonomy: lvl });
  refresh();
  return { ok: true, message: `${AGENT_INFO[key].name}: ${AUTONOMY_LABEL[lvl]}` };
}

export async function setAgentEnabledAction(key: string, enabled: boolean): Promise<ActionResult> {
  await requireSession();
  if (!parse(z.object({ key: keySchema, enabled: z.boolean() }), { key, enabled })) return { ok: false, error: BAD_REQUEST };
  if (!isAgentKey(key)) return { ok: false, error: "Unknown agent." };
  await upsertAgent(key, { enabled: Boolean(enabled) });
  await note(`${enabled ? "Resumed" : "Paused"} ${AGENT_INFO[key].name}`, key, { enabled: Boolean(enabled) });
  refresh();
  return { ok: true, message: enabled ? `${AGENT_INFO[key].name} is back at work` : `${AGENT_INFO[key].name} is paused` };
}

export async function setAgentModelAction(key: string, model: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(z.object({ key: keySchema, model: z.string().max(400) }), { key, model })) return { ok: false, error: BAD_REQUEST };
  if (!isAgentKey(key)) return { ok: false, error: "Unknown agent." };
  const clean = typeof model === "string" ? model.trim() : "";
  if (clean && !/^[\w.\-:/@[\]]{2,100}$/.test(clean)) return { ok: false, error: "Use a model id like claude-sonnet-5, or leave it empty for the default." };
  await upsertAgent(key, { model: clean || null });
  await note(clean ? `Set ${AGENT_INFO[key].name}'s model to ${clean}` : `Reset ${AGENT_INFO[key].name}'s model to the default`, key, { model: clean || null });
  refresh();
  return { ok: true, message: clean ? "Model saved" : "Using the default model" };
}

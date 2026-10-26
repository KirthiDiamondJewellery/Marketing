import { AGENT_KEYS, AGENT_MONOGRAMS, agentSettings, type AgentKey, type AttentionOSConfig, type Sql } from "@attentionos/core";

export const AGENT_NAMES: Record<AgentKey, string> = {
  analyst: "Analyst",
  strategist: "Strategist",
  copywriter: "Copywriter",
  art_director: "Art Director",
  publisher: "Publisher",
  community: "Community",
  chief_of_staff: "Chief of Staff",
};

export type EnsureWorkspaceInput = {
  name: string;
  slug: string;
  timezone: string;
  /** Use a fixed id (from `config.workspace.id`). */
  id?: string;
};

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "workspace";
}

/**
 * Finds or creates the `workspaces` row. Matches by id when given, else by slug. Name and timezone are kept in sync
 * with the caller (the config file is the source of truth).
 */
export async function ensureWorkspace(sql: Sql, input: EnsureWorkspaceInput): Promise<{ id: string; created: boolean }> {
  if (input.id) {
    const rows = await sql<{ id: string; created: boolean }[]>`
      insert into workspaces (id, name, slug, timezone)
      values (${input.id}, ${input.name}, ${await freeSlug(sql, input.slug, input.id)}, ${input.timezone})
      on conflict (id) do update set name = excluded.name, timezone = excluded.timezone
      returning id, (xmax = 0) as created`;
    return rows[0]!;
  }
  const rows = await sql<{ id: string; created: boolean }[]>`
    insert into workspaces (name, slug, timezone)
    values (${input.name}, ${input.slug}, ${input.timezone})
    on conflict (slug) do update set name = excluded.name, timezone = excluded.timezone
    returning id, (xmax = 0) as created`;
  return rows[0]!;
}

/** A slug that is free or already belongs to `id`; appends -2, -3… otherwise. */
async function freeSlug(sql: Sql, base: string, id: string): Promise<string> {
  const taken = await sql<{ slug: string; id: string }[]>`
    select slug, id from workspaces where slug = ${base} or slug like ${base + "-%"}`;
  const own = taken.find((t) => t.id === id);
  if (own) return own.slug;
  const used = new Set(taken.map((t) => t.slug));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Upserts the six agents plus the chief of staff. With a config, autonomy/model/maxTurns/enabled follow it;
 * without one, existing settings are left alone (only names and monograms are refreshed).
 */
export async function seedAgents(sql: Sql, workspaceId: string, config?: AttentionOSConfig): Promise<void> {
  for (const key of AGENT_KEYS) {
    const name = AGENT_NAMES[key];
    const monogram = AGENT_MONOGRAMS[key];
    if (config) {
      const a = agentSettings(config, key);
      await sql`
        insert into agents (workspace_id, key, name, monogram, autonomy, model, max_turns, enabled)
        values (${workspaceId}, ${key}, ${name}, ${monogram}, ${a.autonomy}, ${a.model ?? null}, ${a.maxTurns ?? null}, ${a.enabled})
        on conflict (workspace_id, key) do update set
          name = excluded.name, monogram = excluded.monogram, autonomy = excluded.autonomy,
          model = excluded.model, max_turns = excluded.max_turns, enabled = excluded.enabled, updated_at = now()`;
    } else {
      await sql`
        insert into agents (workspace_id, key, name, monogram)
        values (${workspaceId}, ${key}, ${name}, ${monogram})
        on conflict (workspace_id, key) do update set name = excluded.name, monogram = excluded.monogram`;
    }
  }
}

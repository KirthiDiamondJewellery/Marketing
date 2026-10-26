"use server";

import { requireSession } from "@/server/auth";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { BRAND_FILES, PLATFORMS, formatViews, loadBrandKit, makeRemixOf } from "@attentionos/core";
import { recordAgentEvent } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, handle as handleSchema, id as idSchema, key, parse, text as textSchema } from "@/server/validate";

/** Mutations for /research. Every change is plain-language logged so the agent stream shows it. */

export type ActionResult<T = undefined> = { ok: true; message: string; data?: T } | { ok: false; error: string };

const ACTOR = "user:studio";

// ---------------------------------------------------------------------------------------------------------------
// Remix an outlier into an idea
// ---------------------------------------------------------------------------------------------------------------

export async function remixOutlier(externalPostId: string): Promise<ActionResult<{ id: string; title: string; blueprintReady: boolean }>> {
  await requireSession();
  if (!parse(idSchema, externalPostId)) return { ok: false, error: "That post is no longer in your research library." };
  const ws = workspace();
  const [post] = await ws.sql<{ id: string; url: string; author_handle: string; x_score: string | null; views: string | null; platform: string; tier: string | null; own_median: string | null; topic: string | null; blueprint_ready: boolean }[]>`
    select ep.id, ep.url, ep.author_handle, ep.x_score::text, ep.views::text, ep.platform, tc.tier,
           (select percentile_cont(0.5) within group (order by p.views)::text from external_posts p
              join tracked_creators c on c.id = p.tracked_creator_id and c.workspace_id = p.workspace_id
             where p.workspace_id = ep.workspace_id and c.tier = 'own' and p.views > 0) as own_median,
           bp.blueprint ->> 'topic' as topic, bp.blueprint is not null as blueprint_ready
      from external_posts ep
      left join tracked_creators tc on tc.id = ep.tracked_creator_id and tc.workspace_id = ep.workspace_id
      left join lateral (
        select t.fingerprint -> 'facets' -> 'blueprint' as blueprint from teardowns t
         where t.workspace_id = ep.workspace_id and t.external_post_id = ep.id and t.fingerprint -> 'facets' ? 'blueprint'
         order by t.created_at desc limit 1
      ) bp on true
     where ep.workspace_id = ${ws.id} and ep.id = ${externalPostId}`;
  if (!post) return { ok: false, error: "That post is no longer in your research library." };
  const [existing] = await ws.sql<{ id: string; title: string }[]>`
    select id, title from content
     where workspace_id = ${ws.id} and status <> 'archived'
       and exists (select 1 from jsonb_array_elements(source_refs) s where s ->> 'type' = 'external_post' and s ->> 'id' = ${post.id})
     limit 1`;
  if (existing) return { ok: true, message: `Already an idea: ${existing.title}`, data: { ...existing, blueprintReady: post.blueprint_ready } };

  const own = post.tier === "own";
  const views = post.views ? Number(post.views) : null;
  const x = own ? (views && post.own_median ? Math.round((views / Number(post.own_median)) * 10) / 10 : null) : post.x_score ? Number(post.x_score) : null;
  const remixOf = makeRemixOf({ externalPostId: post.id, url: post.url, handle: post.author_handle, platform: post.platform, own, views, x });
  // The caption and spoken hook are other people's text: they never become the title the Copywriter reads.
  // The checked blueprint's topic can (it passed the teardown checks).
  const title = post.topic ? `Remix: ${post.topic}` : `Remix: ${own ? "your" : `@${remixOf.handle}'s`} ${formatViews(views) ? `${formatViews(views)}-view ` : ""}${post.platform} post`;
  const handle = `@${remixOf.handle}`;
  const why = `${remixOf.line}. Same hook, beats and format; your topic, proof and words.`;
  const [row] = await ws.sql<{ id: string }[]>`
    insert into content (workspace_id, title, status, kind, source_refs, brief, created_by)
    values (${ws.id}, ${title}, 'idea', 'reel',
            ${ws.sql.json([{ type: "external_post", id: post.id, url: post.url }] as never)},
            ${ws.sql.json({ header: title, kind: "remix", why, remixOf } as never)},
            ${ACTOR})
    returning id`;
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: ACTOR,
    kind: "progress",
    message: own ? `Added an idea from one of your own breakouts: ${title}` : `Added an idea from ${handle}'s outlier: ${title}`,
    data: { contentId: row!.id, externalPostId: post.id },
  });
  revalidatePath("/research");
  revalidatePath("/content");
  return { ok: true, message: `Added to ideas: ${title}`, data: { id: row!.id, title, blueprintReady: post.blueprint_ready } };
}

// ---------------------------------------------------------------------------------------------------------------
// Trend radar
// ---------------------------------------------------------------------------------------------------------------

const TREND_STATUSES = ["new", "shortlisted", "dismissed"] as const;

export async function setTrendStatus(trendId: string, status: (typeof TREND_STATUSES)[number]): Promise<ActionResult> {
  await requireSession();
  const args = parse(z.object({ trendId: idSchema, status: key }), { trendId, status });
  if (!args) return { ok: false, error: BAD_REQUEST };
  if (!TREND_STATUSES.includes(status)) return { ok: false, error: "Unknown trend status." };
  const ws = workspace();
  const [row] = await ws.sql<{ title: string }[]>`
    update trends set status = ${status} where workspace_id = ${ws.id} and id = ${trendId} returning title`;
  if (!row) return { ok: false, error: "That trend is gone." };
  if (status !== "new") {
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id,
      agent: ACTOR,
      kind: "progress",
      message: `${status === "shortlisted" ? "Shortlisted" : "Dismissed"} a trend: ${row.title}`,
      data: { trendId, status },
    });
  }
  revalidatePath("/research");
  return { ok: true, message: status === "shortlisted" ? "Shortlisted. The Strategist will consider it for the next brief." : status === "dismissed" ? "Dismissed" : "Moved back to new" };
}

// ---------------------------------------------------------------------------------------------------------------
// Tracked creators (brand/competitors.yaml is the source of truth; the table mirrors it)
// ---------------------------------------------------------------------------------------------------------------

const TIERS = ["core", "adjacent", "aspirational", "remake"] as const;
type Tier = (typeof TIERS)[number];

const norm = (h: string) => h.trim().replace(/^@+/, "").toLowerCase();

type Item = { start: number; end: number; handle: string; platform: string; indent: string; keyIndent: string };

function unquote(v: string): string {
  const s = v.replace(/\s+#.*$/, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** Line-level view of `creators:` items, so edits keep the user's comments and formatting. */
function parseCreators(text: string): { lines: string[]; listLine: number; items: Item[]; flowEmpty: boolean } {
  const lines = text.split("\n");
  const listLine = lines.findIndex((l) => /^creators\s*:/.test(l));
  if (listLine < 0) return { lines, listLine, items: [], flowEmpty: false };
  const flowEmpty = /^creators\s*:\s*\[\s*\]\s*(#.*)?$/.test(lines[listLine]!);
  return { lines, listLine, items: collect(lines, listLine), flowEmpty };
}

function collect(lines: string[], listLine: number): Item[] {
  const items: Item[] = [];
  let cur: Item | null = null;
  let i = listLine + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const dash = /^(\s*)-\s+(.*)$/.exec(line);
    if (dash && (!cur || dash[1] === cur.indent)) {
      if (cur) {
        cur.end = lastContent(lines, cur.start, i);
        items.push(cur);
      }
      const keyCol = line.indexOf(dash[2]!);
      cur = { start: i, end: i, handle: "", platform: "", indent: dash[1]!, keyIndent: " ".repeat(keyCol) };
      readKey(cur, dash[2]!);
      continue;
    }
    if (!/^\s/.test(line)) break;
    if (cur) readKey(cur, line.trim());
  }
  if (cur) {
    cur.end = lastContent(lines, cur.start, i);
    items.push(cur);
  }
  return items;
}

function lastContent(lines: string[], start: number, before: number): number {
  let j = before - 1;
  while (j > start && (!lines[j]!.trim() || /^\s*#/.test(lines[j]!))) j--;
  return j;
}

function readKey(item: Item, kv: string) {
  const m = /^(handle|platform)\s*:\s*(.*)$/.exec(kv);
  if (!m) return;
  if (m[1] === "handle") item.handle = unquote(m[2]!);
  else item.platform = unquote(m[2]!);
}

function validateCompetitors(text: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "aos-brandcheck-"));
  try {
    writeFileSync(join(dir, BRAND_FILES.brand), "name: check\n");
    writeFileSync(join(dir, BRAND_FILES.competitors), text);
    loadBrandKit(dir);
    return null;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return msg.replace(/^competitors\.yaml:\s*/, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function competitorsPath(): string {
  return join(workspace().root, "brand", BRAND_FILES.competitors);
}

function readCompetitors(): string {
  const p = competitorsPath();
  return existsSync(p) ? readFileSync(p, "utf8") : "creators: []\n";
}

function writeChecked(text: string): string | null {
  const problem = validateCompetitors(text);
  if (problem) return `competitors.yaml wouldn't be valid after this change: ${problem}`;
  writeFileSync(competitorsPath(), text);
  return null;
}

const yamlString = (s: string) => JSON.stringify(s);

const addCreatorInput = z.object({ handle: handleSchema, platform: key, tier: z.string().max(100), notes: textSchema(2000).optional() });

export async function addCreator(raw: { handle: string; platform: string; tier: string; notes?: string }): Promise<ActionResult> {
  await requireSession();
  const input = parse(addCreatorInput, raw);
  if (!input) return { ok: false, error: BAD_REQUEST };
  const h = norm(input.handle);
  if (!/^[a-z0-9._-]{2,40}$/.test(h)) return { ok: false, error: "Use the account's handle, like @creator_handle (letters, numbers, dots and underscores)." };
  if (!(PLATFORMS as readonly string[]).includes(input.platform)) return { ok: false, error: "Pick a platform." };
  const tier: Tier = (TIERS as readonly string[]).includes(input.tier) ? (input.tier as Tier) : "core";
  const notes = input.notes?.trim().slice(0, 200) || undefined;

  const text = readCompetitors();
  const parsed = parseCreators(text);
  if (parsed.items.some((it) => norm(it.handle) === h && it.platform === input.platform)) {
    return { ok: false, error: `@${h} is already tracked on that platform.` };
  }
  const usesAt = parsed.items.some((it) => it.handle.startsWith("@"));
  const indent = parsed.items[0]?.indent ?? "  ";
  const keyIndent = parsed.items[0]?.keyIndent ?? `${indent}  `;
  const block = [
    `${indent}- handle: ${yamlString(usesAt ? `@${h}` : h)}`,
    `${keyIndent}platform: ${input.platform}`,
    `${keyIndent}tier: ${tier}`,
    ...(notes ? [`${keyIndent}notes: ${yamlString(notes)}`] : []),
  ];
  const lines = [...parsed.lines];
  if (parsed.listLine < 0) {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push("", "creators:", ...block, "");
  } else if (parsed.flowEmpty || !parsed.items.length) {
    lines.splice(parsed.listLine, 1, "creators:", ...block);
  } else {
    const last = parsed.items[parsed.items.length - 1]!;
    lines.splice(last.end + 1, 0, ...block);
  }
  const problem = writeChecked(lines.join("\n"));
  if (problem) return { ok: false, error: problem };

  const ws = workspace();
  const stored = usesAt ? `@${h}` : h;
  const [existing] = await ws.sql<{ id: string }[]>`
    select id from tracked_creators where workspace_id = ${ws.id} and platform = ${input.platform} and lower(ltrim(handle, '@')) = ${h}`;
  if (existing) {
    await ws.sql`update tracked_creators set active = true, tier = ${tier}, notes = coalesce(${notes ?? null}, notes) where workspace_id = ${ws.id} and id = ${existing.id}`;
  } else {
    await ws.sql`
      insert into tracked_creators (workspace_id, platform, handle, tier, active, notes)
      values (${ws.id}, ${input.platform}, ${stored}, ${tier}, true, ${notes ?? null})`;
  }
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: ACTOR,
    kind: "progress",
    message: `Started tracking @${h} on ${input.platform}. The Analyst adds them to the next scan.`,
    data: { handle: h, platform: input.platform, tier },
  });
  revalidatePath("/research");
  revalidatePath("/brand");
  return { ok: true, message: `Tracking @${h}. Their baseline fills in after the next scan.` };
}

export async function removeCreator(handle: string, platform: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(z.object({ handle: handleSchema, platform: key }), { handle, platform })) return { ok: false, error: BAD_REQUEST };
  const h = norm(handle);
  const parsed = parseCreators(readCompetitors());
  const item = parsed.items.find((it) => norm(it.handle) === h && it.platform === platform);
  if (item) {
    const lines = [...parsed.lines];
    lines.splice(item.start, item.end - item.start + 1);
    const remaining = parsed.items.length - 1;
    if (remaining === 0) lines[parsed.listLine] = "creators: []";
    const problem = writeChecked(lines.join("\n"));
    if (problem) return { ok: false, error: problem };
  }
  const ws = workspace();
  await ws.sql`
    update tracked_creators set active = false
     where workspace_id = ${ws.id} and platform = ${platform} and lower(ltrim(handle, '@')) = ${h} and tier <> 'own'`;
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: ACTOR,
    kind: "progress",
    message: `Stopped tracking @${h}. Their past posts stay in the library.`,
    data: { handle: h, platform },
  });
  revalidatePath("/research");
  revalidatePath("/brand");
  return { ok: true, message: `Stopped tracking @${h}` };
}

export async function setCreatorTier(handle: string, platform: string, tier: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(z.object({ handle: handleSchema, platform: key, tier: key }), { handle, platform, tier })) return { ok: false, error: BAD_REQUEST };
  if (!(TIERS as readonly string[]).includes(tier)) return { ok: false, error: "Unknown tier." };
  const h = norm(handle);
  const parsed = parseCreators(readCompetitors());
  const item = parsed.items.find((it) => norm(it.handle) === h && it.platform === platform);
  if (!item) return { ok: false, error: `@${h} isn't in competitors.yaml. Add them first.` };
  const lines = [...parsed.lines];
  let done = false;
  for (let i = item.start; i <= item.end; i++) {
    const m = /^(\s*(?:-\s+)?)tier\s*:\s*[^#]*(#.*)?$/.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}tier: ${tier}${m[2] ? ` ${m[2]}` : ""}`;
      done = true;
      break;
    }
  }
  if (!done) {
    const at = lines.slice(item.start, item.end + 1).findIndex((l) => /platform\s*:/.test(l));
    lines.splice(item.start + (at < 0 ? 0 : at) + 1, 0, `${item.keyIndent}tier: ${tier}`);
  }
  const problem = writeChecked(lines.join("\n"));
  if (problem) return { ok: false, error: problem };
  const ws = workspace();
  await ws.sql`
    update tracked_creators set tier = ${tier}
     where workspace_id = ${ws.id} and platform = ${platform} and lower(ltrim(handle, '@')) = ${h} and tier <> 'own'`;
  revalidatePath("/research");
  return { ok: true, message: `@${h} is now ${tier === "aspirational" ? "an" : "a"} ${tier} creator` };
}

import "server-only";
import { workspace } from "@/server/workspace";

/** Read models for /inbox: triage (DMs and comments), keyword automations and leads. */

export type InboxFilter = "needs" | "all" | "done";
export const INBOX_FILTERS: InboxFilter[] = ["needs", "all", "done"];

export type TriageItem = {
  id: string;
  kind: "dm" | "comment";
  platform: string;
  from: string | null;
  /** UNTRUSTED text from the platform. Render as text only. */
  text: string;
  prefilter: string | null;
  intent: string | null;
  reason: string | null;
  temperature: "hot" | "warm" | "cold" | null;
  draft: string | null;
  status: "new" | "drafted" | "approved" | "sent" | "ignored";
  receivedAt: string;
  /** The post a comment was left on. */
  post: { title: string | null; caption: string | null } | null;
  approval: { ref: string; status: string; text: string | null } | null;
  /** Derived for the UI: what the person needs to know at a glance. */
  state: "needs_draft" | "needs_you" | "sending" | "sent" | "ignored" | "handled";
};

type Row = {
  id: string;
  kind: "dm" | "comment";
  platform: string;
  from_handle: string | null;
  text: string;
  prefilter: string | null;
  classification: { intent?: string; reason?: string } | null;
  temperature: TriageItem["temperature"];
  draft_reply: string | null;
  status: TriageItem["status"];
  received_at: Date;
  post_title: string | null;
  post_caption: string | null;
  ap_ref: string | null;
  ap_status: string | null;
  ap_preview: { text?: string; draft?: string } | null;
};

function stateOf(r: Row): TriageItem["state"] {
  if (r.status === "sent") return "sent";
  if (r.status === "ignored") return r.prefilter === "auto" ? "handled" : "ignored";
  if (r.ap_status === "approved" || r.status === "approved") return "sending";
  if (!r.draft_reply) return "needs_draft";
  return "needs_you";
}

export async function getTriage(filter: InboxFilter): Promise<{ items: TriageItem[]; counts: Record<InboxFilter, number> & { hot: number } }> {
  const ws = workspace();
  const rows = await ws.sql<Row[]>`
    select t.id, t.kind, t.platform, t.from_handle, t.text, t.prefilter, t.classification, t.temperature, t.draft_reply,
           t.status, t.received_at, p.post_title, p.post_caption, a.ref as ap_ref, a.status as ap_status, a.preview as ap_preview
      from triage_items t
      left join lateral (
        select c.title as post_title, po.caption as post_caption from posts po left join content c on c.id = po.content_id
         where po.workspace_id = t.workspace_id and t.provider_post_id is not null
           and (po.provider_post_id = t.provider_post_id or po.platform_post_id = t.provider_post_id)
         limit 1
      ) p on true
      left join lateral (
        select ref, status, preview from approvals
         where workspace_id = t.workspace_id and subject_id = t.id and kind in ('dm_reply', 'comment_reply')
         order by requested_at desc limit 1
      ) a on true
     where t.workspace_id = ${ws.id}
     order by t.received_at desc
     limit 200`;
  const all = rows.map(
    (r): TriageItem => ({
      id: r.id,
      kind: r.kind,
      platform: r.platform,
      from: r.from_handle,
      text: r.text,
      prefilter: r.prefilter,
      intent: r.classification?.intent ?? null,
      reason: r.classification?.reason ?? null,
      temperature: r.temperature,
      draft: r.draft_reply,
      status: r.status,
      receivedAt: r.received_at.toISOString(),
      post: r.post_title || r.post_caption ? { title: r.post_title, caption: r.post_caption } : null,
      approval: r.ap_ref ? { ref: r.ap_ref, status: r.ap_status ?? "pending", text: r.ap_preview?.text ?? r.ap_preview?.draft ?? null } : null,
      state: stateOf(r),
    }),
  );
  const needs = (i: TriageItem) => i.state === "needs_you" || i.state === "needs_draft";
  const rank = { hot: 0, warm: 1, cold: 2 } as const;
  const sorted = (xs: TriageItem[]) =>
    filter === "needs" ? [...xs].sort((a, b) => (rank[a.temperature ?? "cold"] ?? 3) - (rank[b.temperature ?? "cold"] ?? 3) || b.receivedAt.localeCompare(a.receivedAt)) : xs;
  const items = sorted(filter === "needs" ? all.filter(needs) : filter === "done" ? all.filter((i) => !needs(i)) : all);
  return {
    items,
    counts: {
      needs: all.filter(needs).length,
      all: all.length,
      done: all.filter((i) => !needs(i)).length,
      hot: all.filter((i) => needs(i) && i.temperature === "hot").length,
    },
  };
}

export type Automation = {
  id: string;
  keyword: string;
  status: string;
  dmText: string | null;
  button: { label: string; url: string } | null;
  requireFollow: boolean;
  post: { platform: string; status: string; title: string | null; utm: string | null } | null;
  guide: string | null;
  leads: number;
  error: string | null;
  createdAt: string;
};

export async function getAutomations(): Promise<Automation[]> {
  const ws = workspace();
  const rows = await ws.sql<
    {
      id: string;
      status: string;
      config: { keyword?: string; dmText?: string; buttons?: { label: string; url: string }[]; requireFollow?: boolean } | null;
      error: string | null;
      created_at: Date;
      word: string | null;
      platform: string | null;
      post_status: string | null;
      utm: string | null;
      title: string | null;
      guide: string | null;
      leads: number;
    }[]
  >`
    select d.id, d.status, d.config, d.error, d.created_at, k.word::text as word, p.platform, p.status as post_status,
           p.utm_content as utm, c.title, lm.title as guide,
           (select count(*)::int from contacts ct where ct.workspace_id = d.workspace_id and upper(ct.keyword) = upper(coalesce(k.word::text, d.config ->> 'keyword'))) as leads
      from dm_automations d
      left join keywords k on k.id = d.keyword_id
      left join posts p on p.id = d.post_id
      left join content c on c.id = p.content_id
      left join lead_magnets lm on lm.id = d.lead_magnet_id
     where d.workspace_id = ${ws.id} and d.status <> 'deleted'
     order by case d.status when 'active' then 0 when 'draft' then 1 when 'paused' then 2 else 3 end, d.created_at desc`;
  return rows.map((r) => ({
    id: r.id,
    keyword: (r.word ?? r.config?.keyword ?? "").toUpperCase(),
    status: r.status,
    dmText: r.config?.dmText ?? null,
    button: r.config?.buttons?.[0] ?? null,
    requireFollow: r.config?.requireFollow ?? false,
    post: r.platform ? { platform: r.platform, status: r.post_status ?? "", title: r.title, utm: r.utm } : null,
    guide: r.guide,
    leads: r.leads,
    error: r.error,
    createdAt: r.created_at.toISOString(),
  }));
}

export type Lead = {
  id: string;
  name: string | null;
  email: string | null;
  handle: string | null;
  platform: string | null;
  source: string | null;
  keyword: string | null;
  utmContent: string | null;
  temperature: "hot" | "warm" | "cold" | null;
  notes: string | null;
  createdAt: string;
  /** The post that produced the lead (matched on utm_content). */
  fromPost: { contentId: string | null; title: string | null; postNumber: number | null } | null;
};

export async function getLeads(): Promise<Lead[]> {
  const ws = workspace();
  const rows = await ws.sql<
    {
      id: string;
      name: string | null;
      email: string | null;
      handle: string | null;
      platform: string | null;
      source: string | null;
      keyword: string | null;
      utm_content: string | null;
      temperature: Lead["temperature"];
      notes: string | null;
      created_at: Date;
      content_id: string | null;
      title: string | null;
      post_number: number | null;
    }[]
  >`
    select ct.id, ct.name, ct.email::text as email, ct.handle, ct.platform, ct.source, ct.keyword, ct.utm_content, ct.temperature,
           ct.notes, ct.created_at, src.content_id, src.title, src.post_number
      from contacts ct
      left join lateral (
        select c.id as content_id, c.title, c.post_number from posts p left join content c on c.id = p.content_id
         where p.workspace_id = ct.workspace_id and ct.utm_content is not null and p.utm_content = ct.utm_content
         order by p.published_at desc nulls last limit 1
      ) src on true
     where ct.workspace_id = ${ws.id}
     order by ct.created_at desc
     limit 200`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    handle: r.handle,
    platform: r.platform,
    source: r.source,
    keyword: r.keyword,
    utmContent: r.utm_content,
    temperature: r.temperature,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
    fromPost: r.utm_content ? { contentId: r.content_id, title: r.title, postNumber: r.post_number } : null,
  }));
}

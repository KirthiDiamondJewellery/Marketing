import { ProviderError, type Lead, type Platform, type WorkspaceContext } from "@attentionos/core";
import { activity, notify } from "@attentionos/module-publishing";

/**
 * Lead handoff. Every lead lands in the built-in `contacts` table (the "lite" CRM) first, then, when a
 * CRM is configured, goes to it. A CRM failure never loses the lead: the contact stays and the owner is told.
 */

export type ContactRow = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  handle: string | null;
  platform: string | null;
  source: string | null;
  keyword: string | null;
  utm_content: string | null;
  temperature: "hot" | "warm" | "cold" | null;
  crm_external_id: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

const RANK = { cold: 0, warm: 1, hot: 2 } as const;

export async function upsertContact(ws: WorkspaceContext, lead: Lead): Promise<{ contact: ContactRow; created: boolean }> {
  const handle = lead.handle?.replace(/^@/, "").trim() || null;
  const email = lead.email?.trim().toLowerCase() || null;
  return ws.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`aos:contacts:${ws.id}`}))`;
    let [existing] = email ? await tx<ContactRow[]>`select * from contacts where workspace_id = ${ws.id} and email = ${email}` : [];
    if (!existing && handle) {
      [existing] = await tx<ContactRow[]>`
        select * from contacts where workspace_id = ${ws.id} and lower(handle) = ${handle.toLowerCase()}
           and (platform = ${lead.platform ?? null} or platform is null or ${lead.platform ?? null}::text is null)
         order by created_at limit 1`;
    }
    if (existing) {
      // Temperature only moves up on a handoff; aging is the triage job's job.
      const temperature = lead.temperature && (!existing.temperature || RANK[lead.temperature] > RANK[existing.temperature]) ? lead.temperature : existing.temperature;
      const [row] = await tx<ContactRow[]>`
        update contacts set
          email = coalesce(email, ${email}), name = coalesce(name, ${lead.name ?? null}), phone = coalesce(phone, ${lead.phone ?? null}),
          handle = coalesce(handle, ${handle}), platform = coalesce(platform, ${lead.platform ?? null}), source = coalesce(source, ${lead.source}),
          keyword = coalesce(${lead.keyword ?? null}, keyword), utm_content = coalesce(${lead.utmContent ?? null}, utm_content),
          temperature = ${temperature}, notes = coalesce(${lead.notes ?? null}, notes), updated_at = now()
         where workspace_id = ${ws.id} and id = ${existing.id}
         returning *`;
      return { contact: row!, created: false };
    }
    const [row] = await tx<ContactRow[]>`
      insert into contacts (workspace_id, email, name, phone, handle, platform, source, keyword, utm_content, temperature, notes)
      values (${ws.id}, ${email}, ${lead.name ?? null}, ${lead.phone ?? null}, ${handle}, ${lead.platform ?? null}, ${lead.source},
              ${lead.keyword ?? null}, ${lead.utmContent ?? null}, ${lead.temperature ?? null}, ${lead.notes ?? null})
      returning *`;
    return { contact: row!, created: true };
  });
}

export type HandoffResult = { contactId: string; created: boolean; crm: "lite" | "sent" | "failed"; crmId?: string; message: string };

export async function handoffLead(ws: WorkspaceContext, lead: Lead): Promise<HandoffResult> {
  const { contact, created } = await upsertContact(ws, lead);
  const crm = ws.providers.crm;
  const who = contact.name ?? (contact.handle ? `@${contact.handle}` : contact.email ?? "a lead");
  if (!crm) {
    if (created) await activity(ws, "community", `Saved ${who} as a ${lead.temperature ?? "new"} lead`, { contactId: contact.id });
    return { contactId: contact.id, created, crm: "lite", message: `Saved ${who} in your contacts.` };
  }
  try {
    const res = await crm.upsertLead({
      ...(contact.email ? { email: contact.email } : {}),
      ...(contact.name ? { name: contact.name } : {}),
      ...(contact.phone ? { phone: contact.phone } : {}),
      ...(contact.handle ? { handle: contact.handle } : {}),
      ...(contact.platform ? { platform: contact.platform as Platform } : {}),
      ...(contact.keyword ? { keyword: contact.keyword } : {}),
      ...(contact.utm_content ? { utmContent: contact.utm_content } : {}),
      ...(contact.temperature ? { temperature: contact.temperature } : {}),
      ...(contact.notes ? { notes: contact.notes } : {}),
      source: contact.source ?? lead.source,
    });
    await ws.sql`update contacts set crm_external_id = ${res.id}, updated_at = now() where workspace_id = ${ws.id} and id = ${contact.id}`;
    await activity(ws, "community", `Sent ${who} to ${crm.id.replace(/^crm-/, "")}`, { contactId: contact.id });
    return { contactId: contact.id, created, crm: "sent", crmId: res.id, message: `Saved ${who} and sent them to your CRM.` };
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : (err as Error).message;
    await notify(ws, { dedupeKey: `crm-failed:${contact.id}`, text: `Couldn't send ${who} to your CRM (${msg}). They're saved in your contacts; I'll try again next time they're updated.`, priority: "normal" });
    return { contactId: contact.id, created, crm: "failed", message: `Saved ${who} in your contacts, but the CRM refused it: ${msg}` };
  }
}

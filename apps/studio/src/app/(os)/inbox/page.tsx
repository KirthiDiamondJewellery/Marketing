import type { Metadata } from "next";
import { PageHeader, EmptyState } from "@/components/content/shared";
import { Toaster } from "@/components/content/toast";
import { LinkTabs, Segmented } from "@/components/research/nav";
import { TriageCard } from "@/components/inbox/triage-card";
import { AutomationCard, LeadStats, LeadsTable } from "@/components/inbox/views";
import { workspace } from "@/server/workspace";
import { INBOX_FILTERS, getAutomations, getLeads, getTriage, type InboxFilter } from "@/server/queries/inbox";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

type View = "conversations" | "automations" | "leads";
const VIEWS: View[] = ["conversations", "automations", "leads"];

const FILTER_LABEL: Record<InboxFilter, string> = { needs: "Needs a reply", all: "All", done: "Done" };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const view: View = VIEWS.includes(pick("view") as View) ? (pick("view") as View) : "conversations";
  const filter: InboxFilter = INBOX_FILTERS.includes(pick("filter") as InboxFilter) ? (pick("filter") as InboxFilter) : "needs";

  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  const now = new Date();
  const [triage, automations, leads] = await Promise.all([getTriage(filter), getAutomations(), getLeads()]);

  const desc =
    triage.counts.needs > 0
      ? `${triage.counts.needs} ${triage.counts.needs === 1 ? "reply waits" : "replies wait"} for you${triage.counts.hot ? `, ${triage.counts.hot} from ${triage.counts.hot === 1 ? "a hot lead" : "hot leads"}` : ""}. Community drafts every reply; nothing is sent until you approve it.`
      : "Community drafts every reply; nothing is sent until you approve it.";

  return (
    <div>
      <PageHeader title="Inbox" description={desc} />

      <LinkTabs
        active={view}
        items={[
          { key: "conversations", label: "Comments and DMs", href: "/inbox", count: triage.counts.needs || null },
          { key: "automations", label: "Keyword DMs", href: "/inbox?view=automations", count: automations.length },
          { key: "leads", label: "Leads", href: "/inbox?view=leads", count: leads.length },
        ]}
      />

      <div className="mt-8">
        {view === "conversations" ? (
          <section aria-label="Comments and DMs">
            <div className="mb-6 flex items-center justify-between gap-4">
              <Segmented
                label="Show"
                active={filter}
                items={INBOX_FILTERS.map((f) => ({
                  key: f,
                  label: (
                    <>
                      {FILTER_LABEL[f]}
                      <span className="tabular text-fg-3">{triage.counts[f]}</span>
                    </>
                  ),
                  href: f === "needs" ? "/inbox" : `/inbox?filter=${f}`,
                }))}
              />
            </div>
            {triage.items.length ? (
              <div className="space-y-4">
                {triage.items.map((item, i) => (
                  <TriageCard key={item.id} item={item} now={now.toISOString()} first={i === triage.items.findIndex((t) => t.state === "needs_you" || t.state === "needs_draft")} />
                ))}
              </div>
            ) : filter === "needs" ? (
              <EmptyState title="Inbox clear" body="Every comment and DM has an answer. Community checks for new ones through the day." />
            ) : (
              <EmptyState title="Nothing here yet" body="Comments and DMs from your connected accounts land here once Community sorts them." />
            )}
          </section>
        ) : null}

        {view === "automations" ? (
          <section aria-label="Keyword DMs" className="space-y-4">
            <p className="mb-2 max-w-[68ch] text-small text-fg-2">
              Comment a keyword on a post and the account sends the guide by DM. Every link carries the post&rsquo;s utm_content, so each lead traces back to the post that earned it.
            </p>
            {automations.length ? (
              automations.map((a) => <AutomationCard key={a.id} a={a} />)
            ) : (
              <EmptyState title="No keyword DMs yet" body="When a post uses a comment-keyword call to action, Community sets up the DM here before it goes live." />
            )}
          </section>
        ) : null}

        {view === "leads" ? (
          <section aria-label="Leads">
            {leads.length ? (
              <>
                <LeadStats leads={leads} now={now} />
                <LeadsTable leads={leads} tz={tz} now={now} />
              </>
            ) : (
              <EmptyState title="No leads yet" body="People who comment a keyword and leave their email show up here, with the post that brought them in." />
            )}
          </section>
        ) : null}
      </div>
      <Toaster />
    </div>
  );
}

"use client";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Field, Input, cn } from "@/components/ui";
import { SectionTitle } from "@/components/shell/page-header";
import { useToast } from "@/components/shell/toast";
import { noteSettingsApplying } from "@/lib/settings-apply";
import { saveSettingsAction } from "@/server/actions/settings";
import { AccessSection } from "./access-section";
import { DoctorSection } from "./doctor-section";
import { KeysSection } from "./keys-section";
import { NOTICES } from "./notices";
import { inline } from "./inline";
import { Switch } from "./switch";

export type SettingsData = {
  root: string;
  version: string;
  configError: string | null;
  restartNeeded: boolean;
  /** Saves apply on their own (Studio runs under `attentionos up` / `attentionos studio`). */
  applyLive: boolean;
  /** Why the last saved settings couldn't be applied. */
  applyProblem: { message: string; fix?: string } | null;
  workspace: { name: string; timezone: string; preset: string; mode: "copilot" | "autopilot" };
  timezones: string[];
  modules: { id: string; name: string; description: string; tier: "core" | "default" | "opt-in"; level: number; dependsOn: string[]; requiresAcknowledgement: string[]; enabled: boolean }[];
  acknowledgements: Record<string, boolean>;
  providers: { kind: string; label: string; choice: string; keys: { name: string; set: boolean }[] }[];
  budgets: { perRunUsd: number; dailyUsd: number; scrapingMonthlyUsd: number; imagesDailyUsd: number };
  keys: { name: string; label: string; purpose: string; where: string; editable: boolean; set: boolean; source: "env-file" | "environment" | null }[];
  access: {
    host: string;
    port: string;
    urls: { url: string; label: string }[];
    signIn: boolean;
    trustTailscale: boolean;
    workerEmbedded: boolean;
  };
};

const SECTIONS = [
  ["workspace", "Workspace"],
  ["modules", "Modules"],
  ["providers", "Services"],
  ["budgets", "Budgets"],
  ["keys", "Connections and keys"],
  ["doctor", "Checkup"],
  ["access", "Access"],
] as const;

const LEVELS: Record<number, string> = {
  1: "Level 1 · Research and scripts",
  2: "Level 2 · Edit",
  3: "Level 3 · Publish and engage",
  4: "Level 4 · Autopilot",
};

/** Saves settings through the server action and reports back; shared by every section. */
function useSave() {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const save = (edits: { path: string; value: unknown }[], after?: () => void) =>
    start(async () => {
      const res = await saveSettingsAction(edits);
      if (res.ok) {
        if (res.applying) noteSettingsApplying();
        toast(res.message);
        after?.();
        router.refresh();
      } else toast(res.error, "error");
    });
  return { save, pending };
}

function Section({ id, title, description, children, action }: { id: string; title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24">
      <SectionTitle id={id} action={action}>
        {title}
      </SectionTitle>
      {description ? <p className="-mt-2 mb-5 max-w-[68ch] text-small text-fg-2">{inline(description)}</p> : null}
      {children}
    </section>
  );
}

export function SettingsView({ data }: { data: SettingsData }) {
  return (
    <div className="flex flex-col gap-12 pb-24">
      <nav aria-label="Settings sections" className="-mt-4 flex flex-wrap gap-1.5">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-md px-3 py-1.5 text-small text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg">
            {label}
          </a>
        ))}
      </nav>

      {data.configError ? (
        <Card className="signal-left" role="alert">
          <p className="text-small font-medium text-fg">Your settings file has a problem, so Studio is showing the settings it started with.</p>
          <p className="mt-1 font-mono text-log text-fg-2">{data.configError}</p>
          <p className="mt-2 text-small text-fg-2">{inline("Fix config/attentionos.config.ts, then run `./aos doctor`.")}</p>
        </Card>
      ) : data.applyProblem ? (
        <Card className="signal-left" role="alert">
          <p className="text-small font-medium text-fg">Your saved settings couldn&apos;t be applied, so AttentionOS is still running with the previous ones.</p>
          <p className="mt-1 font-mono text-log text-fg-2">{data.applyProblem.message}</p>
          {data.applyProblem.fix ? <p className="mt-2 text-small text-fg-2">{inline(data.applyProblem.fix)}</p> : null}
        </Card>
      ) : data.restartNeeded ? (
        <Card padded={false} className="px-5 py-4">
          {data.applyLive ? (
            <p className="text-small text-fg-2" role="status">
              <span className="font-medium text-fg">Applying your saved settings…</span> Studio and the worker restart with them; this page reconnects in a moment.
            </p>
          ) : (
            <p className="text-small text-fg-2">
              <span className="font-medium text-fg">Saved changes are waiting for a restart.</span> Stop Studio (Ctrl-C in its terminal) and start it again so every page and the
              worker use them.
            </p>
          )}
        </Card>
      ) : null}

      <WorkspaceSection data={data} />
      <ModulesSection data={data} />
      <ProvidersSection data={data} />
      <BudgetsSection data={data} />
      <Section id="keys" title="Connections and keys" description="Keys live in your workspace's .env file, never in the settings file. Studio shows which are set but never shows their values.">
        <KeysSection keys={data.keys} />
      </Section>
      <Section id="doctor" title="Checkup" description="The same checks as `./aos doctor`: tools, database, services and the worker, each with a plain fix.">
        <DoctorSection />
      </Section>
      <Section id="access" title="Access" description="Where Studio is listening and how to open it from your phone or another computer.">
        <AccessSection access={data.access} version={data.version} />
      </Section>
    </div>
  );
}

function WorkspaceSection({ data }: { data: SettingsData }) {
  const { save, pending } = useSave();
  const [name, setName] = useState(data.workspace.name);
  const [timezone, setTimezone] = useState(data.workspace.timezone);
  const [mode, setMode] = useState(data.workspace.mode);
  const changed = name.trim() !== data.workspace.name || timezone.trim() !== data.workspace.timezone || mode !== data.workspace.mode;

  const submit = () => {
    const edits: { path: string; value: unknown }[] = [];
    if (name.trim() !== data.workspace.name) edits.push({ path: "workspace.name", value: name });
    if (timezone.trim() !== data.workspace.timezone) edits.push({ path: "workspace.timezone", value: timezone });
    if (mode !== data.workspace.mode) edits.push({ path: "mode", value: mode });
    if (edits.length) save(edits);
  };

  return (
    <Section id="workspace" title="Workspace">
      <Card>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Brand name" htmlFor="ws-name" hint="Shown across Studio and in your morning brief.">
              <Input id="ws-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Timezone" htmlFor="ws-tz" hint="Schedules, quiet hours and filming deadlines use it.">
              <Input id="ws-tz" list="ws-tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Chicago" autoComplete="off" />
              <datalist id="ws-tz-list">
                {data.timezones.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
          </div>

          <fieldset>
            <legend className="mb-2 text-small font-medium text-fg">How your agents run</legend>
            <div className="grid gap-3 md:grid-cols-2" role="radiogroup">
              <ModeCard
                checked={mode === "copilot"}
                onSelect={() => setMode("copilot")}
                title="On request"
                body="Agents run AI work when you ask: chat, Run now, approvals and Claude Code. Scheduled data jobs (syncs, scoring) still run in the background."
              />
              <ModeCard
                checked={mode === "autopilot"}
                onSelect={() => setMode("autopilot")}
                title="Autopilot"
                body="Agents also run AI work on their own schedule: research overnight, the morning brief, edits from your phone. Keep AttentionOS running (./aos start in your AttentionOS folder)."
              />
            </div>
            <p className="mt-3 max-w-[72ch] text-caption text-fg-3">
              AI work runs on your own Claude Code login (<code className="font-mono">claude -p</code>) on this machine, using your Claude plan. To use an
              Anthropic API key instead, set <code className="font-mono">runner: {"{"} engine: &quot;api&quot; {"}"}</code> in your config and add the key below.
            </p>
          </fieldset>

          <div className="flex items-center justify-between gap-4">
            <p className="text-caption text-fg-3">Preset: {data.workspace.preset}</p>
            <Button type="submit" disabled={!changed || pending}>
              {pending ? "Saving…" : "Save workspace"}
            </Button>
          </div>
        </form>
      </Card>
    </Section>
  );
}

function ModeCard({ checked, onSelect, title, body }: { checked: boolean; onSelect: () => void; title: string; body: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "rounded-md border p-4 text-left transition-colors duration-[120ms]",
        checked ? "border-brand bg-brand-tint/40" : "border-border hover:bg-surface-2",
      )}
    >
      <span className="flex items-center gap-2 text-h3 font-medium text-fg">
        <span aria-hidden className={cn("inline-block size-3.5 rounded-full border-2", checked ? "border-brand bg-brand" : "border-border-strong")} />
        {title}
      </span>
      <span className="mt-1.5 block text-small text-fg-2">{body}</span>
    </button>
  );
}

function ModulesSection({ data }: { data: SettingsData }) {
  const { save, pending } = useSave();
  const [open, setOpen] = useState<string | null>(null);
  const byLevel = new Map<number, SettingsData["modules"]>();
  for (const m of data.modules) byLevel.set(m.level, [...(byLevel.get(m.level) ?? []), m]);
  const ackUsers = (ack: string) => data.modules.filter((m) => m.requiresAcknowledgement.includes(ack)).map((m) => m.name);
  const acks = Object.keys(NOTICES).filter((k) => k in data.acknowledgements);

  return (
    <Section id="modules" title="Modules" description="Each module is part of your team's job. Core modules are always on; the rest switch on as you reach their setup level.">
      {data.modules.length === 0 ? (
        <Card>
          <p className="text-small text-fg-2">{inline("Studio couldn't find the module list in this install. Run `./aos doctor` to see what's on.")}</p>
        </Card>
      ) : (
        <Card padded={false}>
          {[...byLevel.entries()].map(([level, mods], gi) => (
            <div key={level} className={cn(gi > 0 && "border-t border-border")}>
              <div className="px-6 pt-5 pb-1 text-caption font-medium text-fg-3">{LEVELS[level] ?? `Level ${level}`}</div>
              <ul>
                {mods.map((m) => {
                  const waiting = m.requiresAcknowledgement.filter((a) => !data.acknowledgements[a]);
                  return (
                    <li key={m.id} className="flex items-start gap-4 px-6 py-3.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-body font-medium text-fg">{m.name}</span>
                          {m.tier === "core" ? <Badge>Core</Badge> : m.tier === "opt-in" ? <Badge tone="info">Opt-in</Badge> : null}
                          {m.enabled && waiting.length ? <Badge tone="warning">Waiting for your notice</Badge> : null}
                        </div>
                        <p className={cn("mt-0.5 text-small text-fg-2", open !== m.id && "line-clamp-1")}>{m.description}</p>
                        {m.description.length > 120 ? (
                          <button type="button" className="mt-0.5 text-caption text-fg-3 hover:text-fg" onClick={() => setOpen(open === m.id ? null : m.id)}>
                            {open === m.id ? "Less" : "More"}
                          </button>
                        ) : null}
                      </div>
                      <Switch
                        checked={m.enabled}
                        disabled={m.tier === "core" || pending}
                        label={m.tier === "core" ? `${m.name} is always on` : `${m.enabled ? "Turn off" : "Turn on"} ${m.name}`}
                        onChange={(on) => save([{ path: `modules.${m.id}.enabled`, value: on }])}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </Card>
      )}

      <h3 className="mt-8 mb-1 text-h3 font-medium text-fg">Notices</h3>
      <p className="mb-4 max-w-[68ch] text-small text-fg-2">A few features touch other companies&apos; platforms or licenses. Each stays off until you&apos;ve read its notice and agreed.</p>
      <div className="grid gap-3 md:grid-cols-2">
        {acks.map((key) => {
          const n = NOTICES[key]!;
          const on = Boolean(data.acknowledgements[key]);
          const users = ackUsers(key);
          return (
            <Card key={key} padded={false} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-body font-medium text-fg">{n.title}</div>
                  <div className="text-caption text-fg-3">Used by {users.length ? users.join(", ") : n.usedBy}</div>
                </div>
                <Switch checked={on} disabled={pending} label={`${on ? "Withdraw" : "Accept"} the notice: ${n.title}`} onChange={(v) => save([{ path: `acknowledgements.${key}`, value: v }])} />
              </div>
              <p className="text-small text-fg-2">{n.body}</p>
              {n.alternative ? <p className="text-caption text-fg-3">{n.alternative}</p> : null}
              <a className="text-caption text-fg-2 underline decoration-border-strong underline-offset-4 hover:text-fg" href={n.href} target="_blank" rel="noreferrer">
                Read the full notice
              </a>
            </Card>
          );
        })}
      </div>
    </Section>
  );
}

function ProvidersSection({ data }: { data: SettingsData }) {
  return (
    <Section
      id="providers"
      title="Services"
      description="Which outside service does each job. To switch one, change `providers` in config/attentionos.config.ts; Checkup below tests each connection."
    >
      <Card padded={false}>
        <ul className="divide-y divide-border">
          {data.providers.map((p) => {
            const missing = p.keys.filter((k) => !k.set);
            return (
              <li key={p.kind} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5">
                <div className="min-w-0">
                  <div className="text-body text-fg">{p.label}</div>
                  <div className="text-small text-fg-2">{p.choice === "none" ? "Off" : p.choice}</div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {p.keys.length === 0 ? (
                    <Badge>{p.choice === "none" ? "Off" : "No key needed"}</Badge>
                  ) : missing.length ? (
                    <Badge tone="warning">Missing {missing.map((k) => k.name).join(", ")}</Badge>
                  ) : (
                    <Badge tone="success">Key set</Badge>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </Section>
  );
}

function BudgetsSection({ data }: { data: SettingsData }) {
  const { save, pending } = useSave();
  const fields = [
    ["dailyUsd", "Each day, AI", "No new AI work starts once this is spent that day."],
    ["perRunUsd", "Each task, AI", "A single task stops when it reaches this."],
    ["scrapingMonthlyUsd", "Each month, research", "Checked before every competitor scan."],
    ["imagesDailyUsd", "Each day, images", "Generated images only."],
  ] as const;
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(fields.map(([k]) => [k, String(data.budgets[k])])));
  const changed = fields.filter(([k]) => Number(values[k]) !== data.budgets[k]);
  return (
    <Section id="budgets" title="Budgets" description="Spending limits in US dollars. AttentionOS checks them before it spends and alerts you instead of overspending.">
      <Card>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed.length) save(changed.map(([k]) => ({ path: `budgets.${k}`, value: values[k] })));
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map(([k, label, hint]) => (
              <Field key={k} label={label} htmlFor={`budget-${k}`} hint={hint}>
                <div className="relative">
                  <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-3">
                    $
                  </span>
                  <Input
                    id={`budget-${k}`}
                    inputMode="decimal"
                    type="number"
                    min={k === "dailyUsd" || k === "perRunUsd" ? 0.01 : 0}
                    step="0.01"
                    className="pl-7 tabular"
                    value={values[k]}
                    onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                  />
                </div>
              </Field>
            ))}
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={!changed.length || pending}>
              {pending ? "Saving…" : "Save budgets"}
            </Button>
          </div>
        </form>
      </Card>
    </Section>
  );
}

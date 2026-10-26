"use client";
import { useState, type ReactNode } from "react";
import { CircleCheck, CircleDashed, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import type { AccountMatch } from "@attentionos/module-onboarding/handles";
import { Badge, Button, Input } from "@/components/ui";
import { PlatformGlyph } from "@/motion";
import { checkConnectionAction, completeStepAction, saveConnectionKeyAction } from "@/server/actions/onboarding";
import { StepFooter, StepHeader, useSetupAction } from "./parts";
import type { StepProps } from "./wizard";

const NAMES: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", x: "X", facebook: "Facebook", threads: "Threads" };

type Service = {
  id: "apify" | "zernio";
  key: "APIFY_TOKEN" | "ZERNIO_API_KEY";
  name: string;
  unlocks: string;
  cost: string;
  steps: string[];
  link: { href: string; label: string };
  placeholder: string;
};

const SERVICES: Service[] = [
  {
    id: "apify",
    key: "APIFY_TOKEN",
    name: "Apify",
    unlocks: "Reads public posts: yours (views, captions and the video files your voice is learned from) and your competitors' (to find their outliers).",
    cost: "About $0 to $29 a month. The free plan's monthly credit covers a small setup; AttentionOS stops at your scraping budget.",
    steps: ["Create a free account at apify.com.", "Open Settings, then API & Integrations.", "Copy your personal API token and paste it here."],
    link: { href: "https://console.apify.com/settings/integrations", label: "Open Apify" },
    placeholder: "apify_api_…",
  },
  {
    id: "zernio",
    key: "ZERNIO_API_KEY",
    name: "Zernio",
    unlocks: "Publishes your posts, brings back your real analytics (reach, saves, watch time) and runs comment-to-DM.",
    cost: "Your first 2 social accounts are free.",
    steps: ["Sign up at zernio.com and connect your social accounts there.", "Open Settings, then API, and create a key.", "Paste it here. We'll list the accounts it can see."],
    link: { href: "https://zernio.com", label: "Open Zernio" },
    placeholder: "Paste your Zernio API key",
  },
];

function MatchRow({ m }: { m: AccountMatch }) {
  const name = NAMES[m.platform] ?? m.platform;
  const icon =
    m.state === "connected" ? (
      <CircleCheck className="size-4 text-success" strokeWidth={1.75} aria-label="Connected" />
    ) : m.state === "missing" ? (
      <CircleDashed className="size-4 text-fg-3" strokeWidth={1.75} aria-label="Not connected" />
    ) : m.state === "extra" && m.account?.status === "connected" ? (
      <CircleCheck className="size-4 text-fg-3" strokeWidth={1.75} aria-label="Connected" />
    ) : (
      <TriangleAlert className="size-4 text-warning" strokeWidth={1.75} aria-label="Needs a look" />
    );
  const text: Record<AccountMatch["state"], ReactNode> = {
    connected: <>Connected as @{m.account?.handle}</>,
    other: (
      <>
        Zernio has @{m.account?.handle}, not {m.handle}. Connect {m.handle} in Zernio if that's the one you post from.
      </>
    ),
    expired: <>Needs reconnecting inside Zernio.</>,
    missing: <>Not connected yet. Connect {name} inside Zernio, then press Refresh.</>,
    extra: m.account?.status === "connected" ? <>@{m.account?.handle} is connected (you didn&apos;t list it in setup).</> : <>@{m.account?.handle} needs reconnecting inside Zernio.</>,
  };
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 text-fg-2">
        <PlatformGlyph platform={m.platform} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-small text-fg">
          {name}
          {m.handle ? <span className="text-fg-3"> · {m.handle}</span> : null}
        </p>
        <p className="text-caption text-fg-2">{text[m.state]}</p>
      </div>
      <span className="mt-0.5">{icon}</span>
    </li>
  );
}

function ServiceCard({ s, view }: { s: Service; view: StepProps["view"] }) {
  const { run, pending } = useSetupAction();
  const [value, setValue] = useState("");
  const check = view.state.data.connect.checks[s.id];
  const saved = view.keys[s.key];
  const status = check ? (
    check.ok ? (
      <Badge tone="success">Connected</Badge>
    ) : (
      <Badge tone="warning">Needs a look</Badge>
    )
  ) : saved ? (
    <Badge tone="neutral">Key saved</Badge>
  ) : (
    <Badge tone="brand">Recommended</Badge>
  );
  const matches = s.id === "zernio" && check?.ok ? view.accounts : [];

  return (
    <li className="flex flex-col rounded-lg border border-border bg-surface-1 p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-h3 font-medium text-fg">{s.name}</h2>
        {status}
      </div>
      <p className="mt-2 text-small text-fg">{s.unlocks}</p>
      <p className="mt-1 text-small text-fg-2">{s.cost}</p>
      <ol className="mt-4 flex list-decimal flex-col gap-1 pl-5 text-small text-fg-2">
        {s.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <a href={s.link.href} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1.5 self-start text-small text-brand-fg hover:text-brand-hover md:min-h-0">
        {s.link.label}
        <ExternalLink className="size-3.5" strokeWidth={1.75} />
      </a>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${s.name} key`}
          placeholder={saved ? "Saved. Paste a new one to replace it." : s.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="sm:flex-1"
        />
        {value.trim() ? (
          <Button variant="secondary" className="h-10" disabled={pending} onClick={() => void run(() => saveConnectionKeyAction(s.key, value), { onOk: () => setValue("") })}>
            {pending ? "Checking" : "Save and check"}
          </Button>
        ) : (
          <Button variant="secondary" className="h-10" disabled={pending || !saved} onClick={() => void run(() => checkConnectionAction(s.id))}>
            {pending ? "Checking" : s.id === "zernio" && check?.ok ? (
              <>
                <RefreshCw className="size-4" strokeWidth={1.75} />
                Refresh
              </>
            ) : (
              "Check"
            )}
          </Button>
        )}
      </div>
      {check ? <p className={check.ok ? "mt-3 text-small text-fg-2" : "mt-3 text-small text-warning"}>{check.detail}</p> : null}
      {matches.length ? (
        <ul className="mt-3 divide-y divide-border border-t border-border" aria-label="Your accounts in Zernio">
          {matches.map((m) => (
            <MatchRow key={`${m.platform}:${m.handle}:${m.account?.handle ?? ""}`} m={m} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Step 3: the two keys that let the team work without the owner copying anything. Both optional. */
export function KeysStep({ view, nav }: StepProps) {
  const none = !view.keys.APIFY_TOKEN && !view.keys.ZERNIO_API_KEY;
  return (
    <div className="flex flex-1 flex-col">
      <StepHeader
        title="Two keys, and the team does the rest"
        lede="With these, your agents pull your posts and your competitors' on their own. Both are optional and you can add them later in Settings. Keys stay in your workspace's private settings file on this computer."
      />
      <ul className="mt-10 grid gap-4 md:grid-cols-2">
        {SERVICES.map((s) => (
          <ServiceCard key={s.id} s={s} view={view} />
        ))}
      </ul>
      {none ? (
        <p className="mt-4 text-small text-fg-2">
          Without either key the team can't read any posts yet: your voice and competitor research wait until you add one.
        </p>
      ) : null}
      <StepFooter
        busy={nav.busy}
        onBack={nav.back}
        onSkip={none ? nav.skip : undefined}
        primary={{ label: "Continue", onClick: () => void nav.finish(() => completeStepAction("keys")) }}
      />
    </div>
  );
}

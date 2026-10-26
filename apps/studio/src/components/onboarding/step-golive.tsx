"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, CircleDashed, ExternalLink } from "lucide-react";
import { motion } from "motion/react";
import { Badge, Button, Input } from "@/components/ui";
import { Switch } from "@/components/settings/switch";
import { useToast } from "@/components/shell/toast";
import { AutopilotRing, EASE_OUT } from "@/motion";
import { checkConnectionAction, goLiveAction, goToStepAction, saveConnectionKeyAction, telegramTestAction } from "@/server/actions/onboarding";
import { Section, Segmented, StepFooter, StepHeader, useSetupAction } from "./parts";
import type { StepProps } from "./wizard";

function TelegramCard({ view }: StepProps) {
  const { run, pending } = useSetupAction();
  const [value, setValue] = useState("");
  const check = view.state.data.connect.checks.telegram;
  const saved = view.keys.TELEGRAM_BOT_TOKEN;
  return (
    <Section
      title="Telegram (optional)"
      hint="Your morning brief, approve and reject buttons, and alerts, on your phone. Reply to the bot to talk to your Chief of Staff."
    >
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-small text-fg-2">
        <li>In Telegram, message @BotFather and send /newbot.</li>
        <li>Pick a name; BotFather replies with a token. Paste it here.</li>
        <li>Open your new bot and press Start, then press Check.</li>
      </ol>
      <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-small text-brand-fg hover:text-brand-hover md:min-h-0">
        Open BotFather
        <ExternalLink className="size-3.5" strokeWidth={1.75} />
      </a>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="Telegram bot token"
          placeholder={saved ? "Saved. Paste a new one to replace it." : "Paste your bot token"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="sm:flex-1"
        />
        {value.trim() ? (
          <Button variant="secondary" className="h-10" disabled={pending} onClick={() => void run(() => saveConnectionKeyAction("TELEGRAM_BOT_TOKEN", value), { onOk: () => setValue("") })}>
            Save and check
          </Button>
        ) : (
          <Button variant="secondary" className="h-10" disabled={pending || !saved} onClick={() => void run(() => checkConnectionAction("telegram"))}>
            {pending ? "Checking" : "Check"}
          </Button>
        )}
      </div>
      {check ? <p className={check.ok ? "mt-3 text-small text-fg-2" : "mt-3 text-small text-warning"}>{check.detail}</p> : null}
      {check?.ok && view.keys.TELEGRAM_CHAT_ID ? (
        <Button variant="ghost" className="mt-2" disabled={pending} onClick={() => void run(() => telegramTestAction())}>
          Send a test message
        </Button>
      ) : null}
    </Section>
  );
}

/** Step 7: how much the team does on its own, Telegram, Autopilot; then today's plan and the Agents view. */
export function GoLiveStep(props: StepProps) {
  const { view, nav } = props;
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [live, setLive] = useState(false);
  const allKey = Object.values(view.team.autonomy).every((a) => a === "review_key");
  const [autonomy, setAutonomy] = useState<"review_all" | "review_key">(allKey ? "review_key" : "review_all");
  const [autopilot, setAutopilot] = useState(view.team.mode === "autopilot");
  const d = view.state.data;
  const status = (id: string) => view.steps.find((s) => s.id === id)?.status ?? "todo";

  const lines = [
    { step: "you", title: "You", detail: Object.keys(d.content.handles).length ? `${Object.keys(d.content.handles).length} account${Object.keys(d.content.handles).length === 1 ? "" : "s"}${d.business.url ? ` and ${d.business.url}` : ""}` : "No accounts yet" },
    { step: "keys", title: "Keys", detail: [view.keys.APIFY_TOKEN ? "Apify" : "", view.keys.ZERNIO_API_KEY ? "Zernio" : ""].filter(Boolean).join(" and ") || "None yet: add them in Settings" },
    { step: "competitors", title: "Competitors", detail: d.strategy.competitors.length ? `${d.strategy.competitors.length} creators watched` : "None picked" },
    { step: "review", title: "Brand Kit", detail: [d.business.approvedAt ? "business approved" : "", d.voice.approvedAt ? "voice approved" : ""].filter(Boolean).join(", ") || "Drafts not approved yet" },
  ];

  const goLive = () =>
    start(async () => {
      const r = await goLiveAction({ autonomy, autopilot }).catch(() => ({ ok: false as const, error: "Studio couldn't reach the server. Try again." }));
      if (!r.ok) return void toast(r.error, "error");
      setLive(true);
      try {
        // Let the Agents view open with Wake the team.
        window.localStorage.removeItem("aos.wake.day");
      } catch {
        // Storage blocked: the Agents view just skips the intro.
      }
      setTimeout(() => router.push(r.redirect ?? "/agents"), 1700);
    });

  if (live) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-bg" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-8 text-center">
          <AutopilotRing play closed size={132} />
          <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.32, ease: EASE_OUT }} className="font-display text-display-l text-fg">
            Your team is live
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9, duration: 0.3 }} className="text-body text-fg-2">
            Opening your agents
          </motion.p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <StepHeader title="Go live" lede="Last choices. Everything here can be changed later in Settings." />

      <div className="mt-10 flex flex-col gap-4">
        <Section title="What waits for your OK" hint="Start with everything. Most owners loosen this after the first week.">
          <Segmented
            label="Approvals"
            value={autonomy}
            onChange={setAutonomy}
            options={[
              { value: "review_all", label: "Review everything" },
              { value: "review_key", label: "Review key posts only" },
            ]}
          />
          <p className="mt-3 text-small text-fg-2">
            {autonomy === "review_all" ? "Every script, edit, post and reply waits for you." : "Routine work goes ahead; posts that sell, make claims or reply to people wait for you."}
          </p>
        </Section>

        <Section title="Work on a schedule">
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-body text-fg">Autopilot</span>
              <span className="block text-small text-fg-2">
                Overnight research, the morning brief and follow-ups run on their own, on your Claude plan, while the computer running AttentionOS is on. Off means agents work when you ask.
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              {autopilot ? <AutopilotRing play closed size={28} /> : null}
              <Switch checked={autopilot} onChange={setAutopilot} label="Autopilot" />
            </span>
          </label>
        </Section>

        <TelegramCard {...props} />

        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
          {lines.map((l) => {
            const done = status(l.step) === "done";
            return (
              <li key={l.step} className="flex items-center gap-3 p-4">
                {done ? <CircleCheck className="size-5 shrink-0 text-success" strokeWidth={1.75} aria-label="Done" /> : <CircleDashed className="size-5 shrink-0 text-fg-3" strokeWidth={1.75} aria-label="Not done" />}
                <div className="min-w-0 flex-1">
                  <p className="text-body text-fg">{l.title}</p>
                  <p className="truncate text-small text-fg-2">{l.detail}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    start(async () => {
                      if ((await goToStepAction(l.step)).ok) router.replace("/setup");
                    })
                  }
                >
                  {done ? "Edit" : "Finish"}
                </Button>
              </li>
            );
          })}
        </ul>
        <p className="flex items-center gap-2 text-small text-fg-2">
          <Badge tone="brand">Next</Badge> The Strategist plans today&apos;s filming from what the team found.
        </p>
      </div>

      <StepFooter busy={nav.busy || pending} onBack={nav.back} primary={{ label: "Go live", onClick: goLive }} />
    </div>
  );
}

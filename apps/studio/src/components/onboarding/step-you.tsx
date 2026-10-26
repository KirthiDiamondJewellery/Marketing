"use client";
import { useState } from "react";
import { cleanHandle, SETUP_PLATFORMS, type SetupPlatform } from "@attentionos/module-onboarding/handles";
import { Field, Input } from "@/components/ui";
import { PlatformGlyph } from "@/motion";
import { saveYouAction } from "@/server/actions/onboarding";
import { isActive, StatusLine, StepFooter, StepHeader } from "./parts";
import type { StepProps } from "./wizard";

const LABEL: Record<SetupPlatform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", x: "X" };
const PLACEHOLDER: Record<SetupPlatform, string> = {
  instagram: "@yourname",
  tiktok: "@yourname",
  youtube: "@yourchannel",
  linkedin: "linkedin.com/in/yourname",
  x: "@yourname",
};

/** Step 2: the website (read in the background) and the accounts the team should learn from. */
export function YouStep({ view, nav }: StepProps) {
  const d = view.state.data;
  const [website, setWebsite] = useState(d.business.url || view.brand.website.replace(/^https?:\/\//, ""));
  const [handles, setHandles] = useState<Record<string, string>>(() => ({ ...view.brand.handles, ...d.content.handles }));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const siteRun = d.business.runId ? view.runs[d.business.runId] : undefined;

  const problems = Object.fromEntries(
    SETUP_PLATFORMS.map((p) => [p, touched[p] && handles[p]?.trim() && !cleanHandle(p, handles[p]!) ? "Use the name after the @, or paste your profile link." : null]),
  );
  const count = SETUP_PLATFORMS.filter((p) => handles[p]?.trim() && cleanHandle(p, handles[p]!)).length;
  const save = () => void nav.finish(() => saveYouAction({ website, handles: Object.fromEntries(SETUP_PLATFORMS.map((p) => [p, handles[p] ?? ""])) }));

  return (
    <div className="flex flex-1 flex-col">
      <StepHeader
        title="Where can we find you?"
        lede="Your website and the accounts you post on. The team reads them for you: your offers from the site, your voice from your own videos."
      />

      <div className="mt-10 flex flex-col gap-6">
        <Field label="Your website" htmlFor="site" hint="The Analyst starts reading it as soon as you continue, and drafts your offers and ideal customer.">
          <Input id="site" inputMode="url" autoComplete="url" placeholder="yourbusiness.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </Field>
        {siteRun && (isActive(siteRun) || siteRun.status === "failed") ? (
          <StatusLine tone={siteRun.status === "failed" ? "warn" : "work"}>
            {siteRun.status === "failed" ? `The Analyst couldn't read the site: ${siteRun.error ?? "try again"}` : (siteRun.progress ?? "The Analyst is reading your website")}
          </StatusLine>
        ) : null}

        <fieldset className="flex flex-col gap-3">
          <legend className="text-small font-medium text-fg">Your accounts</legend>
          <p className="-mt-1 text-caption text-fg-3">At least one. A handle or a profile link both work.</p>
          <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
            {SETUP_PLATFORMS.map((p) => (
              <div key={p} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex items-center gap-3">
                  <label htmlFor={`h-${p}`} className="flex w-28 shrink-0 items-center gap-2 text-small text-fg">
                    <span className="text-fg-2">
                      <PlatformGlyph platform={p} />
                    </span>
                    {LABEL[p]}
                  </label>
                  <Input
                    id={`h-${p}`}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={PLACEHOLDER[p]}
                    value={handles[p] ?? ""}
                    aria-invalid={Boolean(problems[p])}
                    onChange={(e) => setHandles((h) => ({ ...h, [p]: e.target.value }))}
                    onBlur={() => setTouched((t) => ({ ...t, [p]: true }))}
                    className="min-w-0 flex-1"
                  />
                </div>
                {problems[p] ? <p className="pl-[124px] text-caption text-danger">{problems[p]}</p> : null}
              </div>
            ))}
          </div>
        </fieldset>
      </div>

      <StepFooter
        busy={nav.busy}
        onBack={nav.back}
        primary={{ label: count ? "Continue" : "Add a handle to continue", onClick: save, disabled: count === 0 }}
      />
    </div>
  );
}

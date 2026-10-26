"use client";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { Badge, cn, type BadgeTone } from "@/components/ui";
import type { CaptionSet, ScriptVersion } from "@/server/queries/content";
import { PlatformGlyph } from "@/motion/PlatformGlyph";
import { fmtRelative, humanize, platformLabel } from "./format";

const ROLE: Record<string, { label: string; when: string }> = {
  hook: { label: "Hook", when: "0–3s" },
  turn: { label: "Turn", when: "" },
  proof: { label: "Proof", when: "" },
  rehook: { label: "Rehook", when: "25–40%" },
  play: { label: "The play", when: "" },
  close: { label: "Close", when: "" },
};

const VERDICT: Record<string, { tone: BadgeTone; label: string }> = {
  PASS: { tone: "success", label: "PASS" },
  FIX: { tone: "warning", label: "FIX" },
  CUT: { tone: "danger", label: "CUT" },
};

const RULES: Record<string, string> = {
  spoken_words_only: "Spoken words only",
  length_window: "Length in range",
  banned_phrases: "No banned phrases",
  cta_matches_type: "Call to action matches the plan",
  hashtags_3_to_5: "3 to 5 niche hashtags",
  hook_source_present: "Hook source recorded",
  keyword_valid_unused: "Keyword valid and unused",
  punctuation_caps: "Punctuation and caps policy",
  banned_openers: "No banned openers",
};

const SCRIPT_STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  approved: { tone: "success", label: "Approved" },
  draft: { tone: "info", label: "Draft" },
  rejected: { tone: "danger", label: "Rejected" },
  superseded: { tone: "neutral", label: "Superseded" },
};

/** Versioned script: beats, the claim ledger and the validator's report. */
export function ScriptPanel({ scripts }: { scripts: ScriptVersion[] }) {
  const [v, setV] = useState(scripts[0]?.version ?? 1);
  const s = scripts.find((x) => x.version === v) ?? scripts[0];
  if (!s) return null;
  const st = SCRIPT_STATUS[s.status] ?? { tone: "neutral" as BadgeTone, label: humanize(s.status) };
  const words = s.body.split(/\s+/).filter(Boolean).length;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        {scripts.length > 1 ? (
          <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="Script versions">
            {scripts.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={x.version === v}
                onClick={() => setV(x.version)}
                className={cn("rounded-[8px] px-3 py-1 text-[13px] tabular transition-colors", x.version === v ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg")}
              >
                v{x.version}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-small tabular text-fg-2">v{s.version}</span>
        )}
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-small text-fg-3">
          {s.createdBy.startsWith("agent:") ? humanize(s.createdBy.slice(6)) : "You"} · {fmtRelative(s.createdAt)} · {words} words
        </span>
      </div>

      <ol className="relative flex flex-col">
        {(s.beats.length ? s.beats : s.body.split("\n").map((text) => ({ role: "", text }))).map((b, i, arr) => {
          const r = ROLE[b.role] ?? { label: humanize(b.role) || `Line ${i + 1}`, when: "" };
          return (
            <li key={i} className="grid grid-cols-[88px_1fr] gap-4 sm:grid-cols-[112px_1fr]">
              <div className="relative flex flex-col items-start pt-0.5">
                <span className={cn("text-small font-medium", b.role === "hook" ? "text-fg" : "text-fg-2")}>{r.label}</span>
                {r.when ? <span className="text-caption text-fg-3">{r.when}</span> : null}
              </div>
              <p className={cn("border-l border-border pb-5 pl-5 text-body", b.role === "hook" ? "text-fg" : "text-fg-2", i === arr.length - 1 && "pb-0")}>{b.text}</p>
            </li>
          );
        })}
      </ol>

      {s.hookSource ? (
        <p className="text-small text-fg-2">
          <span className="text-fg-3">Hook provenance: </span>
          {humanize(s.hookSource.pattern ?? "")}
          {s.hookSource.origin ? ` · ${s.hookSource.origin === "own" ? "your own bank" : s.hookSource.origin === "competitor" ? "competitor bank (structure only)" : "written by hand"}` : ""}
          {s.hookSource.ref && s.hookSource.ref !== "own bank" ? ` · ${s.hookSource.ref}` : ""}
        </p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <h3 className="mb-3 text-h3 font-medium text-fg">Claim ledger</h3>
          {s.claims.length ? (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
              {s.claims.map((c, i) => {
                const vd = VERDICT[c.verdict] ?? { tone: "neutral" as BadgeTone, label: c.verdict };
                return (
                  <li key={i} className="flex gap-3 p-4">
                    <Badge tone={vd.tone} className="mt-0.5 shrink-0 tabular">
                      {vd.label}
                    </Badge>
                    <div className="min-w-0">
                      <p className={cn("text-small text-fg", c.verdict === "CUT" && "text-fg-3 line-through")}>{c.claim}</p>
                      <p className="mt-1 text-caption text-fg-3">
                        {c.source ? <span className="break-all">{c.source}</span> : "No source"}
                        {c.note ? <span className="text-fg-2"> · {c.note}</span> : null}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-4 py-5 text-small text-fg-2">No factual claims in this version, so there is nothing to source.</p>
          )}
        </div>
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-h3 font-medium text-fg">
            Validator
            {s.validator ? <Badge tone={s.validator.ok ? "success" : "danger"}>{s.validator.ok ? "Passed" : "Blocked"}</Badge> : null}
          </h3>
          {s.validator?.checks?.length ? (
            <ul className="flex flex-col gap-2">
              {s.validator.checks.map((c) => (
                <li key={c.rule} className="flex items-start gap-2.5 text-small">
                  {c.ok ? <Check className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={2} /> : <X className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={2} />}
                  <span className={c.ok ? "text-fg-2" : "text-fg"}>
                    {RULES[c.rule] ?? humanize(c.rule)}
                    {c.detail ? <span className="text-fg-3"> · {c.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-fg-2">Not checked yet.</p>
          )}
          <p className="mt-4 text-caption text-fg-3">These checks run in code and can’t be argued with by an agent.</p>
        </div>
      </div>
    </div>
  );
}

const ORDER = ["instagram", "tiktok", "youtube", "linkedin", "facebook", "x", "threads"];

/** One transcript, one caption per platform. */
export function CaptionTabs({ captions }: { captions: CaptionSet }) {
  const rank = (x: string) => (ORDER.includes(x) ? ORDER.indexOf(x) : 99);
  const platforms = Object.keys(captions).sort((a, b) => rank(a) - rank(b));
  const [p, setP] = useState(platforms[0] ?? "instagram");
  const c = (captions[p] ?? {}) as Record<string, unknown>;
  const text = String(c.caption ?? c.text ?? c.description ?? "");
  const title = c.title ? String(c.title) : null;
  const tags = Array.isArray(c.hashtags) ? (c.hashtags as string[]) : [];
  const keyword = c.keyword ? String(c.keyword) : null;
  const length = (title ? title.length : 0) + text.length;
  return (
    <div className="flex flex-col gap-4">
      <div className="-mx-1 flex flex-wrap gap-1" role="tablist" aria-label="Platforms">
        {platforms.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={x === p}
            onClick={() => setP(x)}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md px-3 text-[13px] transition-colors",
              x === p ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
            )}
          >
            <PlatformGlyph platform={x} size={14} />
            {platformLabel(x)}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-surface-1 p-5">
        {title ? (
          <p className="mb-3 text-body font-medium text-fg">
            <span className="mr-2 text-caption font-normal text-fg-3">Title</span>
            {title}
          </p>
        ) : null}
        <p className="whitespace-pre-line font-mono text-log text-fg">{text}</p>
        {tags.length ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span key={t} className="rounded-sm bg-surface-2 px-2 py-0.5 font-mono text-[12px] text-fg-2">
                {t.startsWith("#") ? t : `#${t}`}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-caption text-fg-3">
          <span className="tabular">{length} characters</span>
          {keyword ? <span>Keyword {keyword}</span> : null}
          {p === "youtube" && title ? <span>{title.length < 100 ? "Title under 100 characters" : "Title too long for YouTube"}</span> : null}
        </div>
      </div>
    </div>
  );
}

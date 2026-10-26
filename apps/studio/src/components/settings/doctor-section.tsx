"use client";
import { useState, useTransition } from "react";
import { CircleAlert, CircleCheck, CircleMinus, TriangleAlert } from "lucide-react";
import { Button, Card, cn } from "@/components/ui";
import { runDoctorAction } from "@/server/actions/settings";
import { inline } from "./inline";
import type { CheckStatus, DoctorReport } from "@/server/doctor";

const ICON: Record<CheckStatus, { Icon: typeof CircleCheck; className: string; label: string }> = {
  pass: { Icon: CircleCheck, className: "text-success", label: "Passed" },
  warn: { Icon: TriangleAlert, className: "text-warning", label: "Warning" },
  fail: { Icon: CircleAlert, className: "text-danger", label: "Needs fixing" },
  skip: { Icon: CircleMinus, className: "text-fg-3", label: "Skipped" },
};

export function DoctorSection() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setError(null);
      const res = await runDoctorAction();
      if (res.ok) setReport(res.report);
      else setError(res.error);
    });

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-small text-fg-2" aria-live="polite">
          {pending
            ? "Checking tools, the database and each service. With the speech model installed this takes up to a minute."
            : report
              ? `${report.summary} Checked ${new Date(report.ranAt).toLocaleTimeString()}.`
              : "Nothing checked yet."}
        </p>
        <Button onClick={run} disabled={pending}>
          {pending ? "Checking…" : report ? "Check again" : "Run checkup"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-small text-danger">
          {error}
        </p>
      ) : null}
      {report ? (
        <div className={cn("mt-6 flex flex-col gap-6", pending && "opacity-60")}>
          {report.sections.map((s) => (
            <div key={s.title}>
              <h3 className="mb-2 text-small font-medium text-fg-2">{s.title}</h3>
              <ul className="flex flex-col gap-2">
                {s.checks.map((c, i) => {
                  const { Icon, className, label } = ICON[c.status];
                  return (
                    <li key={`${c.label}-${i}`} className="flex gap-3">
                      <Icon aria-label={label} className={cn("mt-1 size-4 shrink-0", className)} strokeWidth={1.75} />
                      <div className="min-w-0">
                        <div className="text-small text-fg">
                          {c.label}
                          {c.detail ? <span className="text-fg-3"> · {c.detail}</span> : null}
                        </div>
                        {c.fix && c.status !== "pass" ? <div className="mt-0.5 text-caption text-fg-2">{inline(c.fix)}</div> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {report.source === "studio" ? <p className="text-caption text-fg-3">{inline("Studio couldn't start the full checkup, so it ran a short version. For everything, run `./aos doctor`.")}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

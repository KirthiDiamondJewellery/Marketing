import { formatIssues, scriptPackageSchema, zodIssuesToIssues, type ScriptPackage, type ValidationResult } from "@attentionos/guardrails";

/**
 * The revision loop: the model drafts, code validates, and the exact fixes go back to the
 * model. At most `maxRevisions` revisions after the first draft; then the best draft is saved for a person.
 */

export type RevisionAttempt<T> = { attempt: number; ok: boolean; value: T | null; report: ValidationResult };

export type RevisionOutcome<T> = {
  ok: boolean;
  /** The passing value, or the last value that parsed when nothing passed. */
  value: T | null;
  report: ValidationResult;
  attempts: RevisionAttempt<T>[];
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; report: ValidationResult };

export async function reviseUntilValid<T>(opts: {
  generate: (feedback: string | null, attempt: number) => Promise<unknown>;
  parse: (raw: unknown) => ParseResult<T>;
  validate: (value: T) => ValidationResult | Promise<ValidationResult>;
  maxRevisions: number;
  onAttempt?: (a: RevisionAttempt<T>) => void | Promise<void>;
}): Promise<RevisionOutcome<T>> {
  const attempts: RevisionAttempt<T>[] = [];
  let feedback: string | null = null;
  let lastParsed: { value: T; report: ValidationResult } | null = null;
  for (let attempt = 0; attempt <= opts.maxRevisions; attempt++) {
    const raw = await opts.generate(feedback, attempt);
    const parsed = opts.parse(raw);
    let rec: RevisionAttempt<T>;
    if (!parsed.ok) {
      rec = { attempt, ok: false, value: null, report: parsed.report };
    } else {
      const report = await opts.validate(parsed.value);
      rec = { attempt, ok: report.ok, value: parsed.value, report };
      lastParsed = { value: parsed.value, report };
    }
    attempts.push(rec);
    await opts.onAttempt?.(rec);
    if (rec.ok) return { ok: true, value: rec.value, report: rec.report, attempts };
    feedback = revisionFeedback(rec.report, opts.maxRevisions - attempt);
  }
  const last = attempts[attempts.length - 1]!;
  return { ok: false, value: lastParsed?.value ?? null, report: lastParsed?.report ?? last.report, attempts };
}

/** The message sent back to the model: exact, numbered fixes. */
export function revisionFeedback(report: ValidationResult, revisionsLeft: number): string {
  return [
    `Your draft failed ${report.errors.length} check${report.errors.length === 1 ? "" : "s"}. These checks are fixed rules in code; change the draft, not the rules.`,
    "Fix exactly these and return the complete package again as JSON:",
    formatIssues(report),
    report.warnings.length > 0 ? `\nAlso consider (warnings):\n${report.warnings.map((w, i) => `${i + 1}. ${w.message}${w.fix ? ` Fix: ${w.fix}` : ""}`).join("\n")}` : "",
    `Revisions left after this one: ${Math.max(0, revisionsLeft - 1)}.`,
  ].filter(Boolean).join("\n");
}

/** Pulls a JSON object out of model text (plain JSON, or fenced in ```json). */
export function extractJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = (fenced ? fenced[1]! : raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return undefined;
  }
}

export function parseScriptPackage(raw: unknown): ParseResult<ScriptPackage> {
  const json = extractJson(raw);
  if (json === undefined) {
    return { ok: false, report: { ok: false, errors: [{ code: "script.not_json", message: "The reply wasn't a JSON script package.", fix: "Reply with only the JSON object, no prose around it." }], warnings: [] } };
  }
  const parsed = scriptPackageSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, report: { ok: false, errors: zodIssuesToIssues(parsed.error.issues, "script").map((i) => ({ ...i, message: `The script package has the wrong shape: ${i.message}.` })), warnings: [] } };
  }
  return { ok: true, value: parsed.data };
}

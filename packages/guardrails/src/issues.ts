/**
 * Shared result shape for every validator in this package.
 *
 * Messages are written for the person (or model) who has to fix the copy: they say what is wrong,
 * quote the offending words, and `fix` says exactly what to do instead.
 */
export type Issue = {
  /** Stable machine code, e.g. "script.banned_opener". Tests and dashboards key on it. */
  code: string;
  /** Plain-language description of the problem, quoting the words involved. */
  message: string;
  /** Where the problem is, e.g. "beats[2].text" or "captions.youtube.title". */
  path?: string;
  /** What to do about it. */
  fix?: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
};

/** Collects issues while a validator runs. */
export class IssueCollector {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];

  error(code: string, message: string, extra: { path?: string | undefined; fix?: string | undefined } = {}): void {
    this.errors.push(clean({ code, message, ...extra }));
  }

  warn(code: string, message: string, extra: { path?: string | undefined; fix?: string | undefined } = {}): void {
    this.warnings.push(clean({ code, message, ...extra }));
  }

  /** Adds another result's issues, optionally prefixing their paths. */
  merge(result: ValidationResult, pathPrefix?: string): void {
    for (const e of result.errors) this.errors.push(prefix(e, pathPrefix));
    for (const w of result.warnings) this.warnings.push(prefix(w, pathPrefix));
  }

  result(): ValidationResult {
    return { ok: this.errors.length === 0, errors: [...this.errors], warnings: [...this.warnings] };
  }
}

function clean(issue: { code: string; message: string; path?: string | undefined; fix?: string | undefined }): Issue {
  const out: Issue = { code: issue.code, message: issue.message };
  if (issue.path !== undefined && issue.path !== "") out.path = issue.path;
  if (issue.fix !== undefined && issue.fix !== "") out.fix = issue.fix;
  return out;
}

function prefix(issue: Issue, pathPrefix?: string): Issue {
  if (!pathPrefix) return { ...issue };
  return { ...issue, path: issue.path ? `${pathPrefix}.${issue.path}` : pathPrefix };
}

export function okResult(): ValidationResult {
  return { ok: true, errors: [], warnings: [] };
}

export function mergeResults(...results: ValidationResult[]): ValidationResult {
  const c = new IssueCollector();
  for (const r of results) c.merge(r);
  return c.result();
}

/**
 * Turns a result into a numbered fix list. Used to send exact fixes back to a model in a revision
 * loop and to print hook feedback.
 */
export function formatIssues(result: ValidationResult, opts: { includeWarnings?: boolean } = {}): string {
  const lines: string[] = [];
  let n = 1;
  for (const e of result.errors) lines.push(`${n++}. ${describe(e)}`);
  if (opts.includeWarnings) {
    for (const w of result.warnings) lines.push(`${n++}. (warning) ${describe(w)}`);
  }
  return lines.join("\n");
}

function describe(issue: Issue): string {
  const where = issue.path ? ` [${issue.path}]` : "";
  const fix = issue.fix ? ` Fix: ${issue.fix}` : "";
  return `${issue.message}${where}${fix}`;
}

/** Zod issues → our Issue shape, so schema failures read like every other error. */
export function zodIssuesToIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code?: string }>,
  codePrefix: string,
  pathPrefix?: string,
): Issue[] {
  return issues.map((i) => {
    const p = formatPath(i.path);
    const path = pathPrefix ? (p ? `${pathPrefix}.${p}` : pathPrefix) : p;
    const out: Issue = { code: `${codePrefix}.shape`, message: `${path || "(root)"}: ${i.message}` };
    if (path) out.path = path;
    return out;
  });
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

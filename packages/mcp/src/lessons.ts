import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Lessons write-back: every correction becomes a dated rule in `brand/lessons.md`, with its evidence,
 * so later runs read it like any other Brand Kit file. Weekly compaction (learn module) prunes stale rules.
 */

export type LessonInput = {
  rule: string;
  evidence: string;
  /** Where the correction came from, e.g. "approval ap-7" or "edit note on rf-12". */
  source?: string;
  /** Area the rule applies to, e.g. "scripting", "editing". */
  scope?: string;
  actor: string;
  /** YYYY-MM-DD in the workspace timezone. */
  date: string;
};

const HEADER = "# Lessons\n\nDated rules learned from feedback. Each rule cites its evidence. Newest at the bottom.\n";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const normalise = (s: string) => oneLine(s).toLowerCase().replace(/[.!]+$/, "");

export function formatLesson(l: LessonInput): string {
  const scope = l.scope ? ` [${oneLine(l.scope)}]` : "";
  const by = [l.source ? oneLine(l.source) : null, `by ${l.actor}`].filter(Boolean).join(" · ");
  return `- **${l.date}**${scope} ${oneLine(l.rule)}\n  - Evidence: ${oneLine(l.evidence)}\n  - Source: ${by}\n`;
}

/** Whether `rule` already appears as a rule line in the file (case- and whitespace-insensitive). */
export function hasLesson(content: string, rule: string): boolean {
  const target = normalise(rule);
  return content.split("\n").some((line) => {
    const m = /^- \*\*\d{4}-\d{2}-\d{2}\*\*(?: \[[^\]]*\])? (.+)$/.exec(line);
    return m ? normalise(m[1]!) === target : false;
  });
}

export function appendLesson(path: string, lesson: LessonInput): { added: boolean; line: string } {
  const line = formatLesson(lesson);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (hasLesson(current, lesson.rule)) return { added: false, line };
  mkdirSync(dirname(path), { recursive: true });
  const base = current.trim() ? (current.endsWith("\n") ? current : `${current}\n`) : HEADER;
  writeFileSync(path, `${base}\n${line}`);
  return { added: true, line };
}

/** YYYY-MM-DD for `now` in `timezone`. */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

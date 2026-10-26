/**
 * Morning brief, deterministic composer. No LLM: it formats facts from the database into a short,
 * scannable message. It is the fallback when the Chief of Staff's written brief isn't available (Copilot mode,
 * no API key, budget used up, or the run failed), and the data source for the written one.
 *
 * Every section is optional; an empty section is dropped. Numbers are printed as stored, never estimated.
 */

export type FilmItem = {
  title: string;
  lane?: string | null;
  funnelStage?: string | null;
  status: string;
  header?: string | null;
  why?: string | null;
  keyword?: string | null;
  /** Local time label, e.g. "today 6:00 PM". */
  filmBy?: string | null;
  overdue?: boolean;
};

export type ApprovalItem = { ref: string; kind: string; agent: string; summary: string };

export type ResultItem = {
  title: string;
  platform: string;
  views?: number | null;
  xScore?: number | null;
  url?: string | null;
};

export type ScheduledItem = { title: string; platform: string; at: string; assist?: boolean };

export type Alert = { level: "warning" | "danger"; text: string };

export type BriefData = {
  date: string;
  dayLabel: string;
  filmToday: FilmItem[];
  approvals: { total: number; items: ApprovalItem[] };
  scheduledToday: ScheduledItem[];
  yesterday: { published: ResultItem[]; leads: number; hotConversations: number };
  /** Best post of the last 7 days by x-score, when it's a breakout (≥ 2×). */
  breakout?: ResultItem | null;
  alerts: Alert[];
  spend?: { todayUsd: number; dailyBudgetUsd: number } | null;
};

export type BriefSection = { name: string; lines: string[] };
export type Brief = { title: string; sections: BriefSection[]; markdown: string; text: string };

export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`;
  if (abs >= 1_000) return `${trim(n / 1000)}k`;
  return String(Math.round(n));
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** "2.4×", rounded to one decimal. */
export function formatX(x: number): string {
  return `${trim(Math.round(x * 10) / 10)}×`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function resultLine(r: ResultItem): string {
  const parts = [`${r.title} on ${platformName(r.platform)}`];
  const stats: string[] = [];
  if (typeof r.views === "number") stats.push(`${compactNumber(r.views)} views`);
  if (typeof r.xScore === "number") stats.push(`${formatX(r.xScore)} your usual`);
  if (stats.length) parts.push(stats.join(", "));
  return parts.join(": ");
}

const PLATFORM_NAMES: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
};

export function platformName(p: string): string {
  return PLATFORM_NAMES[p] ?? p;
}

export function composeBrief(data: BriefData, opts: { mask?: (s: string) => string; maxApprovals?: number } = {}): Brief {
  const mask = opts.mask ?? ((s: string) => s);
  const maxApprovals = opts.maxApprovals ?? 5;
  const sections: BriefSection[] = [];

  if (data.filmToday.length) {
    sections.push({
      name: "Film today",
      lines: data.filmToday.map((f) => {
        const head = f.header && f.header !== f.title ? `${f.title}: "${f.header}"` : f.title;
        const meta = [f.lane, f.keyword ? `keyword ${f.keyword}` : null, f.filmBy ? `${f.overdue ? "overdue, was due" : "film by"} ${f.filmBy}` : null]
          .filter(Boolean)
          .join(" · ");
        return mask(meta ? `${head} (${meta})` : head);
      }),
    });
  }

  if (data.approvals.total) {
    const shown = data.approvals.items.slice(0, maxApprovals);
    const lines = shown.map((a) => mask(`${a.ref} · ${a.agent}: ${a.summary}`));
    const more = data.approvals.total - shown.length;
    if (more > 0) lines.push(`and ${more} more. Reply "approvals" to see them all.`);
    sections.push({ name: `Waiting for you (${data.approvals.total})`, lines });
  }

  if (data.scheduledToday.length) {
    sections.push({
      name: "Going out today",
      lines: data.scheduledToday.map((s) =>
        mask(s.assist ? `${s.at} ${platformName(s.platform)}: ${s.title}. Post this one yourself (you'll get the file and caption)` : `${s.at} ${platformName(s.platform)}: ${s.title}`),
      ),
    });
  }

  const y = data.yesterday;
  const ylines: string[] = [];
  if (y.published.length) ylines.push(...y.published.map((r) => mask(resultLine(r))));
  else ylines.push("Nothing published yesterday");
  if (y.leads || y.hotConversations) {
    const bits = [];
    if (y.leads) bits.push(plural(y.leads, "new lead"));
    if (y.hotConversations) bits.push(`${plural(y.hotConversations, "hot conversation")} waiting for a reply`);
    ylines.push(bits.join(", "));
  }
  if (data.breakout) ylines.push(mask(`Best this week: ${resultLine(data.breakout)}`));
  sections.push({ name: "Results", lines: ylines });

  const heads = data.alerts.map((a) => mask(a.text));
  if (data.spend && data.spend.dailyBudgetUsd > 0 && data.spend.todayUsd >= data.spend.dailyBudgetUsd * 0.8) {
    heads.push(`AI spend today is $${data.spend.todayUsd.toFixed(2)} of your $${data.spend.dailyBudgetUsd.toFixed(2)} daily budget`);
  }
  if (heads.length) sections.push({ name: "Heads up", lines: heads });

  const title = `Morning brief, ${data.dayLabel}`;
  const markdown = [`*${title}*`, ...sections.map((s) => [`*${s.name}*`, ...s.lines.map((l) => `• ${l}`)].join("\n"))].join("\n\n");
  const text = [title, ...sections.map((s) => [s.name, ...s.lines.map((l) => `- ${l}`)].join("\n"))].join("\n\n");
  return { title, sections, markdown, text };
}

/** The one-paragraph summary printed when a Claude Code session starts in a workspace. */
export function composeSessionSummary(data: Pick<BriefData, "approvals" | "filmToday" | "alerts">, mask: (s: string) => string = (s) => s): string {
  const lines: string[] = [];
  if (data.approvals.total) {
    lines.push(`AttentionOS: ${plural(data.approvals.total, "approval")} waiting.`);
    for (const a of data.approvals.items.slice(0, 5)) lines.push(`  ${a.ref} · ${a.agent}: ${mask(a.summary)}`);
    lines.push("Run /attention:approvals to review them.");
  } else {
    lines.push("AttentionOS: nothing is waiting for your approval.");
  }
  if (data.filmToday.length) lines.push(`${plural(data.filmToday.length, "piece")} to film today. Run /attention:brief for details.`);
  for (const a of data.alerts.slice(0, 3)) lines.push(`Heads up: ${mask(a.text)}`);
  return lines.join("\n");
}

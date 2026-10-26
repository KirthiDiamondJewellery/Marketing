/** Formatting helpers shared by every OS surface (client and server safe, no Node imports). */

const AGENT_NAMES: Record<string, { name: string; monogram: string }> = {
  chief_of_staff: { name: "Chief of Staff", monogram: "Cs" },
  strategist: { name: "Strategist", monogram: "St" },
  copywriter: { name: "Copywriter", monogram: "Cw" },
  art_director: { name: "Art Director", monogram: "Ad" },
  publisher: { name: "Publisher", monogram: "Pb" },
  community: { name: "Community", monogram: "Cm" },
  analyst: { name: "Analyst", monogram: "An" },
};

/** Agent key or actor string ("user:studio", "system") → display name and monogram. */
export function who(agent: string): { name: string; monogram: string; isAgent: boolean } {
  const key = agent.startsWith("agent:") ? agent.slice(6) : agent;
  const a = AGENT_NAMES[key];
  if (a) return { ...a, isAgent: true };
  if (key.startsWith("user:")) return { name: "You", monogram: "You", isAgent: false };
  return { name: "System", monogram: "Sy", isAgent: false };
}

export function agentName(agent: string): string {
  return who(agent).name;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "12 min ago", "3 h ago", "yesterday", "Oct 4". Future times read "in 2 h". */
export function relTime(iso: string | Date | null | undefined, now: number = Date.now(), tz?: string): string {
  if (!iso) return "";
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  const d = now - t;
  const abs = Math.abs(d);
  const future = d < 0;
  if (abs < 45_000) return "just now";
  if (abs < HOUR) {
    const m = Math.max(1, Math.round(abs / MIN));
    return future ? `in ${m} min` : `${m} min ago`;
  }
  if (abs < DAY) {
    const h = Math.round(abs / HOUR);
    return future ? `in ${h} h` : `${h} h ago`;
  }
  if (!future && abs < 2 * DAY) return "yesterday";
  if (future && abs < 2 * DAY) return "tomorrow";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(tz ? { timeZone: tz } : {}) });
}

/** "Thu, 9:00 AM" style, in the workspace timezone. */
export function dayTime(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "short", ...(tz ? { timeZone: tz } : {}) });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) });
  return `${day}, ${time}`;
}

export function clock(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) });
}

export function usd(n: number, opts: { precise?: boolean } = {}): string {
  if (opts.precise || n < 10) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const JOB_LABELS: Record<string, string> = {
  "research.competitor-scan": "Competitor scan",
  "research.trend-radar": "Trend radar",
  "research.own-sync": "Sync your posts",
  "research.teardown": "Teardown",
  "learn.weekly-briefing": "Weekly briefing",
  "learn.post-mortem": "Post-mortem",
  "strategy.daily-brief": "Plan today's filming",
  "scripting.harvest-hooks": "Refresh hook banks",
  "scripting.write-script": "Write a script",
  "editing.prep": "Prep footage",
  "editing.revise": "Re-cut a video",
  "publishing.publish-due": "Publish what's due",
  "publishing.schedule": "Schedule posts",
  "community.dm-triage": "Sort new DMs",
  "ops.morning-brief": "Send the morning brief",
  "ops.write-morning-brief": "Write the morning brief",
  "ops.chief-of-staff": "Answer your message",
  "ops.dispatch-outbox": "Deliver messages",
  "ops.poll-inbound": "Read your replies",
};

/** "research.competitor-scan" → "Competitor scan". */
export function jobLabel(jobId: string): string {
  const known = JOB_LABELS[jobId];
  if (known) return known;
  const name = jobId.includes(".") ? jobId.slice(jobId.indexOf(".") + 1) : jobId;
  const s = name.replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
};

export function platformLabel(p: string): string {
  return PLATFORM_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

export const AUTONOMY_LABEL = {
  review_all: "Review everything",
  review_key: "Review key posts",
  autopilot: "Full autopilot",
} as const;

/** Agent status lines sometimes carry a raw job id ("Running community.dm-triage"); say it in words instead. */
export function humanLabel(label: string | null | undefined): string {
  if (!label) return "";
  return label.replace(/\b(?:Running\s+)?((?:research|learn|strategy|scripting|editing|publishing|community|ops|carousels)\.[a-z][\w-]*)\b/g, (_m, id: string) => jobLabel(id)).replace(/^Running\s+/, "");
}

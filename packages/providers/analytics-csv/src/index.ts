import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  PLATFORMS, ProviderError,
  type AttentionOSConfig, type Logger, type OwnAnalytics, type Platform, type PostMetricsSnapshot, type ProviderHealth,
} from "@attentionos/core";

/**
 * OwnAnalytics from CSV exports, for metrics no API exposes (Instagram skip rate, completion rate) or for
 * accounts with no analytics provider at all. Drop CSV files into the import folder; each row is one
 * metrics snapshot for one post.
 *
 * Folder: ANALYTICS_CSV_DIR in .env, default `imports/analytics/` in the workspace.
 *
 * Columns (header row required, case and spacing ignored, unknown columns ignored):
 *
 * | column            | required | meaning                                                        | aliases                      |
 * |-------------------|----------|----------------------------------------------------------------|------------------------------|
 * | post_id           | one of   | the platform's post id                                         | platform_post_id, media_id, id |
 * | url               | one of   | the post URL (used to match when there's no id)                | permalink, link              |
 * | platform          | no       | instagram, tiktok, youtube, facebook, linkedin, x, threads      | network                      |
 * | account           | no       | provider account id; rows for other accounts are skipped        | account_id                   |
 * | published_at      | no       | when the post went live (ISO 8601 or YYYY-MM-DD)               | publish_time, posted_at, date |
 * | captured_at       | no       | when these numbers were read (default: the file's modified time) | exported_at                 |
 * | views             | no       | plays / views                                                  | plays, video_views           |
 * | reach, likes, comments, shares, saves, follows, profile_visits | no | counts (thousands separators OK)       | saved → saves                |
 * | avg_watch_time_s  | no       | average watch time in seconds                                  | avg_watch_time, average_watch_time |
 * | skip_rate         | no       | share of viewers who swiped away in the first seconds: 0.42, 42 or 42% | skip                 |
 * | completion_rate   | no       | share who watched to the end: 0.18, 18 or 18%                  | completion, watched_full     |
 * | duration_s        | no       | video length in seconds                                        | duration                     |
 * | caption           | no       | caption text                                                   |                              |
 * | clicks            | no       | link clicks                                                    | website_clicks, link_clicks  |
 * | impressions, reposts | no    | counts kept alongside the snapshot                              |                              |
 * | retention         | no       | retention curve: % still watching at each step, `100|82|64|…`   | retention_curve              |
 * | retention_step_s  | no       | seconds between curve points (default 1)                        | retention_interval_s         |
 * | retention_<N>s    | no       | % still watching at second N, one column per point (e.g. retention_3s) | hold_<N>s              |
 *
 * Rates above 1 are read as percentages. Empty cells mean "unknown", never zero. Clicks, impressions, reposts and
 * the retention curve land in `raw.aos` ({ clicks, impressions, reposts, retention: [{ t, pct }] }).
 *
 * Follower history: a CSV with a `followers` column and no post id/url column (or any CSV in a `followers/`
 * subfolder) is read by `listAccountStats` instead: `date`, `followers`, optional `following`, `posts`,
 * `platform`, `account`.
 */

export const PROVIDER_ID = "csv";

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, embedded newlines. Also accepts `;` or tab delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const ALIASES: Record<string, string> = {
  post_id: "post_id", platform_post_id: "post_id", media_id: "post_id", id: "post_id",
  url: "url", permalink: "url", link: "url",
  platform: "platform", network: "platform",
  account: "account", account_id: "account",
  published_at: "published_at", publish_time: "published_at", posted_at: "published_at", date: "published_at",
  captured_at: "captured_at", exported_at: "captured_at",
  views: "views", plays: "views", video_views: "views",
  reach: "reach", likes: "likes", comments: "comments", shares: "shares", saves: "saves", saved: "saves",
  follows: "follows", profile_visits: "profile_visits",
  avg_watch_time_s: "avg_watch_time_s", avg_watch_time: "avg_watch_time_s", average_watch_time: "avg_watch_time_s",
  skip_rate: "skip_rate", skip: "skip_rate",
  completion_rate: "completion_rate", completion: "completion_rate", watched_full: "completion_rate",
  duration_s: "duration_s", duration: "duration_s",
  caption: "caption",
  clicks: "clicks", website_clicks: "clicks", link_clicks: "clicks",
  impressions: "impressions", reposts: "reposts",
  retention: "retention", retention_curve: "retention",
  retention_step_s: "retention_step_s", retention_interval_s: "retention_step_s",
};

/** `retention_3s` / `hold_3s` / `retention_3` → 3 (seconds). */
const retentionPoint = (h: string): number | null => {
  const m = /^(?:retention|hold)_(\d+(?:_\d+)?)s?$/.exec(h);
  return m ? Number(m[1]!.replace("_", ".")) : null;
};

/** A curve cell: `100|82|64`, `100 82 64` or `1.0;0.82` → percentages (0–100). */
export function parseRetentionCurve(cell: string | undefined, stepS = 1): { t: number; pct: number }[] | undefined {
  if (!cell?.trim()) return undefined;
  const parts = cell.split(/[|\s;]+/).map((p) => toNumber(p)).filter((n): n is number => n !== undefined && n >= 0);
  if (parts.length < 2) return undefined;
  const asPct = parts.some((n) => n > 1);
  return parts.map((n, i) => ({ t: Math.round(i * stepS * 100) / 100, pct: Math.min(100, Math.round((asPct ? n : n * 100) * 10) / 10) }));
}

const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().replace(/[,\s]/g, "").replace(/%$/, "");
  if (t === "" || t === "-") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function toRate(v: string | undefined): number | undefined {
  const n = toNumber(v);
  if (n === undefined || n < 0) return undefined;
  const r = n > 1 || (v ?? "").trim().endsWith("%") ? n / 100 : n;
  return r <= 1 ? r : undefined;
}

function toIso(v: string | undefined): string | undefined {
  if (!v?.trim()) return undefined;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Last path segment of a post URL, e.g. the reel short code. */
export function idFromUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop();
  } catch {
    return undefined;
  }
}

export type CsvRowIssue = { line: number; problem: string };

export function parseAnalyticsCsv(
  text: string,
  opts: { capturedAt: string; defaultPlatform?: Platform; accountId?: string },
): { snapshots: PostMetricsSnapshot[]; issues: CsvRowIssue[] } {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return { snapshots: [], issues: [{ line: 1, problem: "the file is empty" }] };
  const cols = header.map((h) => ALIASES[normaliseHeader(h)]);
  const pointCols = header.map((h) => retentionPoint(normaliseHeader(h)));
  if (!cols.includes("post_id") && !cols.includes("url")) {
    return { snapshots: [], issues: [{ line: 1, problem: "needs a post_id or url column" }] };
  }
  const snapshots: PostMetricsSnapshot[] = [];
  const issues: CsvRowIssue[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const rec: Record<string, string> = {};
    cols.forEach((c, j) => {
      if (c && cells[j] !== undefined && rec[c] === undefined) rec[c] = cells[j]!;
    });
    if (opts.accountId && opts.accountId !== "*" && rec.account?.trim() && rec.account.trim() !== opts.accountId) return;
    const url = rec.url?.trim() || undefined;
    const id = rec.post_id?.trim() || (url ? idFromUrl(url) : undefined);
    if (!id) {
      issues.push({ line, problem: "no post id or url" });
      return;
    }
    const platformRaw = rec.platform?.trim().toLowerCase();
    const platform = (platformRaw ? (PLATFORMS as readonly string[]).find((p) => p === platformRaw) : opts.defaultPlatform ?? "instagram") as Platform | undefined;
    if (!platform) {
      issues.push({ line, problem: `unknown platform "${rec.platform}"` });
      return;
    }
    const snap: PostMetricsSnapshot = {
      platformPostId: id,
      platform,
      capturedAt: toIso(rec.captured_at) ?? opts.capturedAt,
    };
    const set = <K extends keyof PostMetricsSnapshot>(k: K, v: PostMetricsSnapshot[K] | undefined) => {
      if (v !== undefined) snap[k] = v;
    };
    set("url", url);
    set("publishedAt", toIso(rec.published_at));
    set("caption", rec.caption?.trim() || undefined);
    set("durationS", toNumber(rec.duration_s));
    set("views", toNumber(rec.views));
    set("reach", toNumber(rec.reach));
    set("likes", toNumber(rec.likes));
    set("comments", toNumber(rec.comments));
    set("shares", toNumber(rec.shares));
    set("saves", toNumber(rec.saves));
    set("follows", toNumber(rec.follows));
    set("profileVisits", toNumber(rec.profile_visits));
    set("avgWatchTimeS", toNumber(rec.avg_watch_time_s));
    set("skipRate", toRate(rec.skip_rate));
    set("completionRate", toRate(rec.completion_rate));
    const aos: Record<string, unknown> = {};
    for (const k of ["clicks", "impressions", "reposts"] as const) {
      const v = toNumber(rec[k]);
      if (v !== undefined) aos[k] = v;
    }
    let curve = parseRetentionCurve(rec.retention, toNumber(rec.retention_step_s) ?? 1);
    if (!curve) {
      const pts = pointCols
        .map((t, j) => (t === null ? null : { t, v: toRate(cells[j]) }))
        .filter((p): p is { t: number; v: number } => p !== null && p.v !== undefined)
        .map((p) => ({ t: p.t, pct: Math.round(p.v * 1000) / 10 }))
        .sort((a, b) => a.t - b.t);
      if (pts.length) curve = pts;
    }
    if (curve) aos.retention = curve;
    snap.raw = { source: "csv", line, ...(Object.keys(aos).length ? { aos } : {}) };
    snapshots.push(snap);
  });
  return { snapshots, issues };
}

export type AccountStatSnapshot = {
  /** Local calendar day the numbers describe (YYYY-MM-DD). */
  day: string;
  platform?: Platform;
  followers?: number;
  following?: number;
  posts?: number;
  capturedAt: string;
};

const FOLLOWER_ALIASES: Record<string, string> = {
  date: "day", day: "day", captured_at: "day",
  followers: "followers", follower_count: "followers", followers_count: "followers",
  following: "following", follows_count: "following",
  posts: "posts", media_count: "posts", post_count: "posts",
  platform: "platform", network: "platform",
  account: "account", account_id: "account",
};

/** True when a CSV header looks like a follower history (a followers column, no post id or url). */
export function isFollowerCsv(text: string): boolean {
  const header = (parseCsv(text.split(/\r?\n/, 1)[0] ?? "")[0] ?? []).map(normaliseHeader);
  return header.some((h) => FOLLOWER_ALIASES[h] === "followers") && !header.some((h) => ["post_id", "url"].includes(ALIASES[h] ?? ""));
}

export function parseFollowersCsv(text: string, opts: { capturedAt: string; accountId?: string; defaultPlatform?: Platform }): { stats: AccountStatSnapshot[]; issues: CsvRowIssue[] } {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return { stats: [], issues: [{ line: 1, problem: "the file is empty" }] };
  const cols = header.map((h) => FOLLOWER_ALIASES[normaliseHeader(h)]);
  if (!cols.includes("day") || !cols.includes("followers")) return { stats: [], issues: [{ line: 1, problem: "needs date and followers columns" }] };
  const stats: AccountStatSnapshot[] = [];
  const issues: CsvRowIssue[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const rec: Record<string, string> = {};
    cols.forEach((c, j) => {
      if (c && cells[j] !== undefined && rec[c] === undefined) rec[c] = cells[j]!;
    });
    if (opts.accountId && opts.accountId !== "*" && rec.account?.trim() && rec.account.trim() !== opts.accountId) return;
    const iso = toIso(rec.day);
    const followers = toNumber(rec.followers);
    if (!iso || followers === undefined) {
      issues.push({ line, problem: !iso ? "no readable date" : "no follower count" });
      return;
    }
    const platformRaw = rec.platform?.trim().toLowerCase();
    const platform = platformRaw ? (PLATFORMS as readonly string[]).find((p) => p === platformRaw) as Platform | undefined : opts.defaultPlatform;
    if (platformRaw && !platform) {
      issues.push({ line, problem: `unknown platform "${rec.platform}"` });
      return;
    }
    const stat: AccountStatSnapshot = { day: /^\d{4}-\d{2}-\d{2}$/.test(rec.day!.trim()) ? rec.day!.trim() : iso.slice(0, 10), followers, capturedAt: opts.capturedAt };
    if (platform) stat.platform = platform;
    const following = toNumber(rec.following);
    if (following !== undefined) stat.following = following;
    const posts = toNumber(rec.posts);
    if (posts !== undefined) stat.posts = posts;
    stats.push(stat);
  });
  return { stats, issues };
}

type Opts = { secret(name: string): string | undefined; config: AttentionOSConfig; log: Logger; cwd?: string };

export type CsvAnalytics = OwnAnalytics & {
  importDir(): string;
  /** Follower history from follower CSVs (see the header comment). */
  listAccountStats(accountId: string, opts?: { since?: string }): Promise<AccountStatSnapshot[]>;
};

export function create(opts: Opts): CsvAnalytics {
  const log = opts.log.child({ provider: PROVIDER_ID });
  const importDir = () => {
    const dir = opts.secret("ANALYTICS_CSV_DIR") ?? "imports/analytics";
    return isAbsolute(dir) ? dir : resolve(opts.cwd ?? process.cwd(), dir);
  };
  return {
    id: PROVIDER_ID,
    importDir,
    async health(): Promise<ProviderHealth> {
      const dir = importDir();
      if (!existsSync(dir)) return { ok: false, detail: `No CSV import folder at ${dir}`, fix: `Create ${dir} and drop your analytics exports there` };
      const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
      return { ok: true, detail: files.length ? `${files.length} CSV export${files.length === 1 ? "" : "s"} ready to import` : "Import folder is ready (no files yet)" };
    },
    async listPostMetrics(accountId, o) {
      const dir = importDir();
      if (!existsSync(dir)) throw new ProviderError(PROVIDER_ID, "not_found", `no CSV import folder at ${dir}`);
      const out: PostMetricsSnapshot[] = [];
      for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort()) {
        const path = join(dir, file);
        const text = readFileSync(path, "utf8");
        if (isFollowerCsv(text)) continue;
        const { snapshots, issues } = parseAnalyticsCsv(text, { capturedAt: statSync(path).mtime.toISOString(), accountId });
        for (const issue of issues) log.warn("skipped a CSV row", { file, ...issue });
        out.push(...snapshots);
      }
      return out
        .filter((s) => !o?.since || !s.publishedAt || s.publishedAt >= o.since)
        .sort((a, b) => (b.publishedAt ?? b.capturedAt).localeCompare(a.publishedAt ?? a.capturedAt))
        .slice(0, o?.limit ?? Number.POSITIVE_INFINITY);
    },
    async listAccountStats(accountId, o) {
      const dir = importDir();
      if (!existsSync(dir)) return [];
      const files: string[] = [];
      for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".csv")).sort()) files.push(join(dir, f));
      const sub = join(dir, "followers");
      if (existsSync(sub) && statSync(sub).isDirectory()) for (const f of readdirSync(sub).filter((x) => x.toLowerCase().endsWith(".csv")).sort()) files.push(join(sub, f));
      const out: AccountStatSnapshot[] = [];
      for (const path of files) {
        const text = readFileSync(path, "utf8");
        if (!path.startsWith(sub) && !isFollowerCsv(text)) continue;
        const { stats, issues } = parseFollowersCsv(text, { capturedAt: statSync(path).mtime.toISOString(), accountId });
        for (const issue of issues) log.warn("skipped a follower CSV row", { file: path, ...issue });
        out.push(...stats);
      }
      return out.filter((s) => !o?.since || s.day >= o.since.slice(0, 10)).sort((a, b) => a.day.localeCompare(b.day));
    },
  };
}

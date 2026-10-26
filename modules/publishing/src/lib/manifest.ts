import type { Platform } from "@attentionos/core";
import type { PlatformCadence } from "../settings.ts";
import { addDays, localDate, weekdayOf, zonedToUtc } from "./time.ts";

/**
 * Week manifest: which piece goes to which platform at which slot. Pure and deterministic, so the plan
 * can be shown as a dry run, approved, and replayed without drift.
 *
 * Slotting:
 * - candidate slots come from each platform's cadence (days × local slot times) in the workspace timezone;
 * - slots in the past (or closer than the lead time) and slots already taken on that platform are skipped;
 * - slots are filled in rounds (each day's best slot first) so posts spread across the week, never more than
 *   `maxPerDay` per local day or `perWeek` per week (counting posts already scheduled);
 * - pieces are placed in priority order: the first piece gets the earliest slot on every platform it targets.
 */

export type ManifestItem = {
  contentId: string;
  title: string;
  /** Platforms this piece may go to. Default: every planned platform. */
  platforms?: Platform[];
  /** Script version used for the idempotency key. */
  version?: number;
};

export type ManifestAccount = { platform: Platform; providerAccountId: string; handle: string };
export type TakenSlot = { platform: Platform; scheduledAt: string };

export type ManifestEntry = {
  contentId: string;
  title: string;
  platform: Platform;
  accountId: string;
  handle: string;
  /** UTC ISO-8601. */
  scheduledAt: string;
  localDate: string;
  localTime: string;
  /** assist = the user posts it themselves from a notification (Instagram main feed by default, ADR-13). */
  mode: "auto" | "assist";
  idempotencyKey: string;
};

export type WeekManifest = {
  weekStart: string;
  timezone: string;
  entries: ManifestEntry[];
  /** Planned slots with nothing to fill them. */
  openSlots: { platform: Platform; localDate: string; localTime: string }[];
  /** Pieces that didn't fit on a platform. */
  unplaced: { contentId: string; platform: Platform; reason: string }[];
  /** Platforms in the cadence that can't be planned, with the reason. */
  skippedPlatforms: { platform: Platform; reason: string }[];
};

export type ManifestInput = {
  weekStart: string;
  timezone: string;
  cadence: Partial<Record<Platform, PlatformCadence>>;
  /** Connected accounts (first per platform is used). */
  accounts: ManifestAccount[];
  /** Platforms the publisher supports. */
  supportedPlatforms: Platform[];
  /** Platforms enabled in the workspace config. */
  enabledPlatforms: Platform[];
  items: ManifestItem[];
  taken: TakenSlot[];
  now: Date;
  leadMinutes: number;
  instagramAutopost: boolean;
};

export function postIdempotencyKey(contentId: string, platform: Platform, version = 1, suffix?: string): string {
  return `post:${contentId}:${platform}:${version}${suffix ? `:${suffix}` : ""}`;
}

type Slot = { platform: Platform; localDate: string; localTime: string; utc: Date };

export function planSlots(platform: Platform, cadence: PlatformCadence, input: Pick<ManifestInput, "weekStart" | "timezone" | "taken" | "now" | "leadMinutes">): Slot[] {
  const earliest = input.now.getTime() + input.leadMinutes * 60_000;
  const weekEnd = zonedToUtc(addDays(input.weekStart, 7), "00:00", input.timezone).getTime();
  const weekStartUtc = zonedToUtc(input.weekStart, "00:00", input.timezone).getTime();
  const takenHere = input.taken
    .filter((t) => t.platform === platform)
    .map((t) => new Date(t.scheduledAt))
    .filter((d) => d.getTime() >= weekStartUtc && d.getTime() < weekEnd);
  const takenMinutes = new Set(takenHere.map((d) => Math.floor(d.getTime() / 60_000)));
  const perDay = new Map<string, number>();
  for (const d of takenHere) {
    const day = localDate(d, input.timezone);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  let remaining = cadence.perWeek - takenHere.length;
  const days = Array.from({ length: 7 }, (_, i) => addDays(input.weekStart, i)).filter((d) => cadence.days.includes(weekdayOf(d)));
  const chosen: Slot[] = [];
  for (let round = 0; round < cadence.slots.length && remaining > 0; round++) {
    const time = cadence.slots[round]!;
    for (const day of days) {
      if (remaining <= 0) break;
      if ((perDay.get(day) ?? 0) >= cadence.maxPerDay) continue;
      const utc = zonedToUtc(day, time, input.timezone);
      if (utc.getTime() < earliest) continue;
      if (takenMinutes.has(Math.floor(utc.getTime() / 60_000))) continue;
      chosen.push({ platform, localDate: day, localTime: time, utc });
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      remaining--;
    }
  }
  return chosen.sort((a, b) => a.utc.getTime() - b.utc.getTime());
}

export function buildWeekManifest(input: ManifestInput): WeekManifest {
  const entries: ManifestEntry[] = [];
  const openSlots: WeekManifest["openSlots"] = [];
  const unplaced: WeekManifest["unplaced"] = [];
  const skippedPlatforms: WeekManifest["skippedPlatforms"] = [];

  const platforms = (Object.keys(input.cadence) as Platform[]).filter((p) => (input.cadence[p]?.perWeek ?? 0) > 0);
  for (const platform of platforms) {
    const cadence = input.cadence[platform]!;
    if (!input.enabledPlatforms.includes(platform)) {
      skippedPlatforms.push({ platform, reason: "not turned on in your workspace config" });
      continue;
    }
    if (!input.supportedPlatforms.includes(platform)) {
      skippedPlatforms.push({ platform, reason: "your publisher can't post there" });
      continue;
    }
    const account = input.accounts.find((a) => a.platform === platform);
    if (!account) {
      skippedPlatforms.push({ platform, reason: "no connected account" });
      continue;
    }
    const slots = planSlots(platform, cadence, input);
    const pieces = input.items.filter((i) => !i.platforms || i.platforms.includes(platform));
    slots.forEach((slot, idx) => {
      const item = pieces[idx];
      if (!item) {
        openSlots.push({ platform, localDate: slot.localDate, localTime: slot.localTime });
        return;
      }
      entries.push({
        contentId: item.contentId,
        title: item.title,
        platform,
        accountId: account.providerAccountId,
        handle: account.handle,
        scheduledAt: slot.utc.toISOString(),
        localDate: slot.localDate,
        localTime: slot.localTime,
        mode: platform === "instagram" && !input.instagramAutopost ? "assist" : "auto",
        idempotencyKey: postIdempotencyKey(item.contentId, platform, item.version ?? 1),
      });
    });
    for (const item of pieces.slice(slots.length)) {
      unplaced.push({ contentId: item.contentId, platform, reason: slots.length === 0 ? "no open slots left this week" : "all slots this week are full" });
    }
  }
  entries.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.platform.localeCompare(b.platform));
  return { weekStart: input.weekStart, timezone: input.timezone, entries, openSlots, unplaced, skippedPlatforms };
}

/** A compact table for tool output and the approval card. */
export function manifestTable(m: WeekManifest): string {
  if (m.entries.length === 0) return "Nothing to schedule this week.";
  const lines = m.entries.map((e) => `${e.localDate} ${e.localTime}  ${e.platform.padEnd(9)} ${e.mode === "assist" ? "(you post)" : "          "} ${e.title}`);
  return lines.join("\n");
}

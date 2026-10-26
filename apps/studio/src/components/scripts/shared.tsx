import type { ScriptItem, ScriptState } from "@/server/queries/scripts";
import { Badge, cn, type BadgeTone } from "@/components/ui";

export const STATE_LABEL: Record<ScriptState, { label: string; tone: BadgeTone }> = {
  writing: { label: "Writing…", tone: "info" },
  needs_ok: { label: "Needs your OK", tone: "warning" },
  draft: { label: "Needs a fix", tone: "warning" },
  ready: { label: "Ready to film", tone: "success" },
  filmed: { label: "Filmed", tone: "neutral" },
  stuck: { label: "Didn't finish", tone: "danger" },
};

export function StateBadge({ item }: { item: ScriptItem }) {
  const s = item.rewriting ? { label: "Rewriting…", tone: "info" as const } : STATE_LABEL[item.state];
  const live = item.state === "writing" || item.rewriting;
  return (
    <Badge tone={s.tone} className={cn("gap-1.5", live && "signal-pulse")}>
      {s.label}
    </Badge>
  );
}

/** The script after its hook (the stored body starts with the hook when the writer included it). */
export function restOfBody(item: Pick<ScriptItem, "hook" | "body">): string {
  const body = item.body.trim();
  const hook = item.hook?.trim();
  if (hook && body.toLowerCase().startsWith(hook.toLowerCase())) return body.slice(hook.length).replace(/^\s+/, "");
  return body;
}

export function filmByText(iso: string | null, tz: string): { text: string; urgent: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  const hours = (d.getTime() - Date.now()) / 3_600_000;
  const day = d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  if (hours < 0) return { text: `Was due ${day}`, urgent: true };
  if (hours < 24) return { text: `Film by ${d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })} today`, urgent: true };
  return { text: `Film by ${day}`, urgent: false };
}

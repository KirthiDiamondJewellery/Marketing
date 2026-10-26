"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, CheckCheck, Loader2, MessageSquare, MessageCircle, Undo2 } from "lucide-react";
import { Badge, Button, Textarea, cn, type BadgeTone } from "@/components/ui";
import { PlatformIcon } from "@/components/content/shared";
import { toast } from "@/components/content/toast";
import { fmtRelative, handle, humanize, platformLabel } from "@/components/content/format";
import { approveAndSend, ignoreItem, restoreItem } from "@/server/actions/inbox";
import type { TriageItem } from "@/server/queries/inbox";

const TEMP: Record<string, { tone: BadgeTone; label: string }> = {
  hot: { tone: "brand", label: "Hot" },
  warm: { tone: "warning", label: "Warm" },
  cold: { tone: "neutral", label: "Cold" },
};

const PREFILTER: Record<string, string> = {
  needs_review: "Needs a person",
  auto: "Handled by a keyword DM",
  spam: "Looks like spam",
};

export function TriageCard({ item, now, first = false }: { item: TriageItem; now: string; first?: boolean }) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(item.draft ?? "");
  const [state, setState] = useState(item.state);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"approve" | "ignore" | "restore" | null>(null);
  const router = useRouter();
  const nowDate = new Date(now);
  const max = item.kind === "comment" ? 300 : 900;
  const open = state === "needs_you" || state === "needs_draft";
  const temp = item.temperature ? TEMP[item.temperature] : null;
  const edited = text.trim() !== (item.draft ?? "").trim();

  const run = (kind: "approve" | "ignore" | "restore") => {
    setBusy(kind);
    start(async () => {
      const res = kind === "approve" ? await approveAndSend(item.id, text) : kind === "ignore" ? await ignoreItem(item.id) : await restoreItem(item.id);
      setBusy(null);
      if (!res.ok) return toast(res.error, { tone: "error" });
      setState(kind === "approve" ? "sending" : kind === "ignore" ? "ignored" : text.trim() ? "needs_you" : "needs_draft");
      toast(res.message, kind === "approve" ? { by: "Community" } : {});
      router.refresh();
    });
  };

  return (
    <article
      className={cn(
        "rounded-lg border border-border bg-surface-1",
        open ? "p-5 sm:p-6" : "p-5",
        open && "signal-left rounded-l-none",
        (state === "ignored" || state === "handled") && "opacity-70",
      )}
      aria-label={`${item.kind === "dm" ? "Message" : "Comment"} from ${handle(item.from) || "someone"}`}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <PlatformIcon platform={item.platform} />
        <span className="text-[14px] font-medium text-fg">{handle(item.from) || "Someone"}</span>
        <span className="inline-flex items-center gap-1 text-caption text-fg-3">
          {item.kind === "dm" ? <MessageSquare className="size-3" /> : <MessageCircle className="size-3" />}
          {item.kind === "dm" ? `DM on ${platformLabel(item.platform)}` : `Comment on ${item.post?.title ? `“${item.post.title}”` : platformLabel(item.platform)}`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {temp ? <Badge tone={temp.tone}>{temp.label}</Badge> : null}
          <span className="text-caption text-fg-3 tabular">{fmtRelative(item.receivedAt, nowDate)}</span>
        </span>
      </header>

      {/* Their words: untrusted, rendered as plain text. */}
      <p className={cn("mt-4 max-w-[68ch] whitespace-pre-line rounded-md bg-surface-2 text-fg", open ? "px-4 py-3 text-[15px] leading-6" : "px-3.5 py-2.5 text-small")}>{item.text}</p>

      <p className={cn("mt-2 text-caption text-fg-3", state === "handled" && "hidden")}>
        {item.prefilter ? (PREFILTER[item.prefilter] ?? humanize(item.prefilter)) : "Not sorted yet"}
        {item.intent ? ` · ${humanize(item.intent)}` : ""}
        {item.reason ? ` · ${item.reason}` : ""}
      </p>

      {open ? (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <label htmlFor={`reply-${item.id}`} className="text-small font-medium text-fg">
              {item.draft ? (edited ? "Your reply" : "Community drafted") : "Your reply"}
            </label>
            <span className={cn("text-caption tabular", text.length > max ? "text-danger" : "text-fg-3")}>
              {text.length}/{max}
            </span>
          </div>
          <Textarea
            id={`reply-${item.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(6, Math.max(2, Math.ceil(text.length / 70)))}
            placeholder={item.kind === "dm" ? "Thanks for reaching out. Want the link to book a call?" : "Thanks for asking. It's the same tile we use in most of our showers."}
            className="resize-y leading-6"
            aria-invalid={text.length > max ? true : undefined}
          />
          {!item.draft ? <p className="mt-1.5 text-caption text-fg-3">Community hasn&rsquo;t drafted a reply yet. Write one, or leave it for the next triage run.</p> : null}
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button variant="ghost" disabled={pending} onClick={() => run("ignore")}>
              {busy === "ignore" ? <Loader2 className="size-4 animate-spin" /> : null}
              Ignore
            </Button>
            <Button variant={first || focused ? "primary" : "secondary"} disabled={pending || !text.trim() || text.length > max} onClick={() => run("approve")}>
              {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Approve and send
            </Button>
          </div>
        </div>
      ) : (
        <Resolved item={item} state={state} text={text} pending={pending} onRestore={() => run("restore")} />
      )}
    </article>
  );
}

function Resolved({ item, state, text, pending, onRestore }: { item: TriageItem; state: TriageItem["state"]; text: string; pending: boolean; onRestore: () => void }) {
  if (state === "sending" || state === "sent") {
    return (
      <div className="mt-4 border-t border-border pt-3">
        <p className="flex items-center gap-1.5 text-caption text-success">
          {state === "sent" ? <CheckCheck className="size-3.5" /> : <Check className="size-3.5" />}
          {state === "sent" ? "Sent" : `Approved${item.approval ? ` (${item.approval.ref})` : ""} · sending`}
        </p>
        <p className="mt-2 max-w-[68ch] whitespace-pre-line text-small text-fg-2">{text || item.draft}</p>
      </div>
    );
  }
  return (
    <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
      <p className="text-caption text-fg-3">{state === "handled" ? "Answered automatically by the keyword DM" : "Ignored. Nothing was sent."}</p>
      {state === "ignored" ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={onRestore}>
          <Undo2 className="size-3.5" />
          Bring back
        </Button>
      ) : null}
    </div>
  );
}

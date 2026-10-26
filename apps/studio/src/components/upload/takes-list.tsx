"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { ArrowRight, CircleAlert, Film, LoaderCircle, Upload, X } from "lucide-react";
import type { UploadView } from "@/server/queries/production";
import { dismissUploadAction, linkUploadAction, restartUploadAction } from "@/server/actions/production";
import { Badge, Button, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { useUploads } from "./upload-provider";
import { bytes, pct } from "./upload-root";

type Script = { id: string; title: string; status: string };

const NO_SCRIPT = "__none__";
const EDIT_LABEL: Record<string, string> = {
  queued: "Up next", prepping: "Prepping", planning: "Planning", rendering: "Rendering", qc: "Checking", review: "Ready for you",
  approved: "Approved", failed: "Stopped", cancelled: "Stopped",
};

function duration(s: number | null): string {
  if (!s && s !== 0) return "";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** The drop target on Film: click to pick files, or drop them here (the whole page accepts drops too). */
export function DropZone({ compact = false, contentId = null }: { compact?: boolean; contentId?: string | null }) {
  const { add } = useUploads();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const n = add(e.dataTransfer.files, { contentId });
    if (!n) toast("Only video files can be uploaded (.mov, .mp4).", "error");
  };
  return (
    <div
      data-dropzone
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "relative flex items-center gap-4 rounded-lg border border-dashed transition-colors",
        compact ? "px-4 py-3" : "flex-col justify-center px-6 py-10 text-center",
        over ? "border-brand bg-brand-tint/40" : "border-border-strong hover:border-fg-3",
      )}
    >
      <Upload className={cn("shrink-0 text-fg-3", compact ? "size-4" : "size-6", over && "text-brand-fg")} strokeWidth={1.5} />
      <div className={cn("min-w-0", compact && "flex-1")}>
        <p className={cn("font-medium text-fg", compact ? "text-small" : "text-h3")}>{compact ? "Drop more takes here" : "Drop your takes here"}</p>
        {!compact ? <p className="mx-auto mt-1 max-w-xs text-small text-fg-2">As many as you like. Each one is matched to its script by what you say in the first minute.</p> : null}
      </div>
      <Button variant="secondary" size={compact ? "sm" : "md"} onClick={() => input.current?.click()} className={compact ? "" : "mt-2"}>
        Choose files
      </Button>
      <input
        ref={input}
        type="file"
        accept="video/*,.mov,.mp4,.m4v,.webm,.mkv"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) add(e.target.files, { contentId });
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Cover({ id, name }: { id: string | null; name: string }) {
  return (
    <div className="relative h-[64px] w-[36px] shrink-0 overflow-hidden rounded-[6px] border border-border bg-surface-2">
      {id ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/${id}`} alt="" className="h-full w-full object-cover" />
      ) : (
        <Film className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-fg-3" strokeWidth={1.5} aria-label={name} />
      )}
    </div>
  );
}

function ScriptPicker({ value, scripts, onPick, label, disabled, subtle }: { value: string; scripts: Script[]; onPick: (contentId: string | null) => void; label: string; disabled?: boolean; subtle?: boolean }) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value === NO_SCRIPT ? null : e.target.value || null)}
      className={cn(
        "h-8 max-w-full rounded-md px-2 text-[13px] focus:border-brand focus:outline-none",
        subtle ? "cursor-pointer border border-transparent bg-transparent text-fg-3 hover:border-border hover:text-fg" : "border border-border-strong bg-surface-1 text-fg-2 hover:text-fg",
      )}
    >
      <option value="" disabled>
        {label}
      </option>
      {scripts.map((s) => (
        <option key={s.id} value={s.id}>
          {s.title}
        </option>
      ))}
      <option value={NO_SCRIPT}>No script: just edit it</option>
    </select>
  );
}

/**
 * Uploaded takes with their match: uploading, listening, "sounds like X (86%)", linked and editing, or an extra take
 * of a script already in the edit. Takes of the same script are grouped. Nothing waits on the match: pick the script
 * at any time.
 */
export function TakesList({ uploads, scripts }: { uploads: UploadView[]; scripts: Script[] }) {
  const router = useRouter();
  const toast = useToast();
  const { items, retry, dismiss } = useUploads();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string } | { ok: false; error: string }>) => {
    setBusy(id);
    const r = await fn();
    setBusy(null);
    if (!r.ok) toast("error" in r && r.error ? r.error : "That didn't work.", "error");
    else if ("message" in r && r.message) toast(r.message);
    router.refresh();
  };
  const link = (u: UploadView, contentId: string | null, replace = false) => run(u.id, () => linkUploadAction(u.id, contentId, { replace }));

  // Local uploads not yet known to the server.
  const known = new Set(uploads.map((u) => u.id));
  const local = items.filter((it) => !(it.result?.uploadId && known.has(it.result.uploadId)));

  // Group linked takes by script; unlinked ones first.
  const open = uploads.filter((u) => u.status !== "linked");
  const groups = new Map<string, UploadView[]>();
  for (const u of uploads.filter((x) => x.status === "linked")) {
    const k = u.contentId ?? u.id;
    groups.set(k, [...(groups.get(k) ?? []), u]);
  }

  if (!local.length && !uploads.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {local.map((it) => (
        <div key={it.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-3">
          <Cover id={null} name={it.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-small font-medium text-fg" title={it.name}>
              {it.name}
            </p>
            {it.status === "error" ? (
              <p className="mt-1 flex items-start gap-1.5 text-small text-danger">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} /> {it.error}
              </p>
            ) : (
              <>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct(it)} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${it.name}`}>
                  <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${pct(it)}%` }} />
                </div>
                <p className="mt-1.5 text-caption text-fg-3 tabular">
                  {it.status === "queued" ? "Waiting" : it.status === "finishing" ? "Saving" : it.status === "done" ? "Uploaded" : `${pct(it)}% of ${bytes(it.size)}`}
                </p>
              </>
            )}
          </div>
          {it.status === "error" ? (
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="secondary" onClick={() => retry(it.id)}>
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => dismiss(it.id)} aria-label={`Remove ${it.name}`}>
                <X className="size-4" strokeWidth={1.75} />
              </Button>
            </div>
          ) : null}
        </div>
      ))}

      {open.map((u) => {
        const best = u.candidates[0];
        return (
          <div key={u.id} className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 px-3 py-3" data-take={u.status}>
            <Cover id={u.coverId} name={u.fileName} />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2">
                <span className="truncate text-small font-medium text-fg" title={u.fileName}>
                  {u.fileName}
                </span>
                <span className="shrink-0 text-caption text-fg-3 tabular">{[duration(u.durationS), u.bytes ? bytes(u.bytes) : ""].filter(Boolean).join(" · ")}</span>
              </p>
              {u.status === "matching" ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-small text-fg-2">
                  <LoaderCircle className="size-3.5 animate-spin text-fg-3" strokeWidth={1.75} /> Listening for which script this is…
                </p>
              ) : u.status === "suggested" && best ? (
                <div className="mt-1.5">
                  <p className="text-small text-fg-2">
                    Sounds like <span className="font-medium text-fg">“{best.title}”</span>{" "}
                    <Badge tone={best.score >= 0.62 ? "success" : best.score >= 0.4 ? "warning" : "neutral"} className="ml-1 tabular">
                      {Math.round(best.score * 100)}% match
                    </Badge>
                  </p>
                  {u.transcript ? <p className="mt-1 line-clamp-1 text-caption italic text-fg-3">“{u.transcript.slice(0, 140)}”</p> : null}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" disabled={busy === u.id} onClick={() => link(u, best.contentId)}>
                      Confirm and edit
                    </Button>
                    <ScriptPicker value="" scripts={scripts.filter((s) => s.id !== best.contentId)} label="Pick another script" onPick={(c) => link(u, c)} disabled={busy === u.id} />
                  </div>
                </div>
              ) : u.status === "failed" ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-small text-danger">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} /> {u.error ?? "This file can't be edited."}
                </p>
              ) : (
                <div className="mt-1.5">
                  <p className="text-small text-fg-2">{u.error ?? "Couldn't tell which script this is."}</p>
                  <div className="mt-2.5">
                    <ScriptPicker value="" scripts={scripts} label="Pick the script" onPick={(c) => link(u, c)} disabled={busy === u.id} />
                  </div>
                </div>
              )}
            </div>
            {u.status !== "matching" ? (
              <button type="button" onClick={() => run(u.id, () => dismissUploadAction(u.id))} className="grid size-7 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label={`Remove ${u.fileName} from the list`}>
                <X className="size-4" strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
        );
      })}

      {[...groups.values()].map((takes) => {
        const editing = takes.find((t) => t.role === "edit") ?? null;
        const title = takes[0]!.contentTitle ?? "Untitled";
        const changeable = Boolean(editing && ["queued", "prepping", "planning"].includes(editing.editStatus ?? ""));
        return (
          <div key={takes[0]!.contentId ?? takes[0]!.id} className="rounded-lg border border-border bg-surface-1">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <p className="min-w-0 flex-1 truncate text-small font-medium text-fg">{title}</p>
              {takes.length > 1 ? <span className="shrink-0 text-caption text-fg-3">{takes.length} takes</span> : null}
              {editing?.editRef ? (
                <Link href="/edits" className="inline-flex shrink-0 items-center gap-1 text-caption text-fg-2 hover:text-fg">
                  {editing.editRef} · {EDIT_LABEL[editing.editStatus ?? ""] ?? editing.editStatus} <ArrowRight className="size-3" strokeWidth={2} />
                </Link>
              ) : null}
            </div>
            <ul>
              {takes.map((u, i) => (
                <li key={u.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5", i > 0 && "border-t border-border")}>
                  <Cover id={u.coverId} name={u.fileName} />
                  <div className="min-w-[160px] flex-1">
                    <p className="truncate text-small text-fg" title={u.fileName}>
                      {u.fileName}
                    </p>
                    <p className="mt-0.5 text-caption text-fg-3">
                      {u.role === "edit" ? (u.editStatus === "cancelled" ? "Edit stopped" : "The take being edited") : "Another take"}
                      {u.linkedBy === "auto" && u.confidence != null ? ` · matched ${Math.round(u.confidence * 100)}%` : ""}
                      {u.durationS ? ` · ${duration(u.durationS)}` : ""}
                    </p>
                    {u.error ? <p className="mt-1 text-caption text-danger">{u.error}</p> : null}
                  </div>
                  <div className="flex shrink-0 justify-end max-sm:w-full max-sm:pl-[48px] max-sm:justify-start">
                  {u.role === "take" && (changeable || !editing || ["failed", "cancelled"].includes(editing.editStatus ?? "")) ? (
                    <Button size="sm" variant="ghost" disabled={busy === u.id} onClick={() => link(u, u.contentId, true)}>
                      Edit this take instead
                    </Button>
                  ) : u.role === "edit" && u.editStatus === "cancelled" ? (
                    <Button size="sm" variant="secondary" disabled={busy === u.id} onClick={() => run(u.id, () => restartUploadAction(u.id))}>
                      Start again
                    </Button>
                  ) : changeable && u.role === "edit" ? (
                    <ScriptPicker value="" scripts={scripts.filter((s) => s.id !== u.contentId)} label="Wrong script?" onPick={(c) => link(u, c)} disabled={busy === u.id} subtle />
                  ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

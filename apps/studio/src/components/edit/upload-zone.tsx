"use client";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { CircleAlert, Film, LoaderCircle, Upload, X } from "lucide-react";
import type { UploadView } from "@/server/queries/production";
import type { TakeScript } from "@/server/queries/edit";
import { dismissUploadAction, linkUploadAction } from "@/server/actions/production";
import { Badge, Button, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { useUploads } from "@/components/upload/upload-provider";
import { bytes, pct } from "@/components/upload/upload-root";

const NO_SCRIPT = "__none__";

function clock(s: number | null): string {
  if (s === null) return "";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function Cover({ id }: { id: string | null }) {
  return (
    <div className="relative h-[64px] w-[36px] shrink-0 overflow-hidden rounded-[6px] border border-border bg-surface-2">
      {id ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/${id}`} alt="" className="h-full w-full object-cover" />
      ) : (
        <Film className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-fg-3" strokeWidth={1.5} aria-hidden />
      )}
    </div>
  );
}

function ScriptPicker({ scripts, label, onPick, disabled }: { scripts: TakeScript[]; label: string; onPick: (contentId: string | null) => void; disabled?: boolean }) {
  return (
    <select
      aria-label={label}
      value=""
      disabled={disabled}
      onChange={(e) => onPick(e.target.value === NO_SCRIPT ? null : e.target.value || null)}
      className="h-8 max-w-full rounded-md border border-border-strong bg-surface-1 px-2 text-[13px] text-fg-2 hover:text-fg focus:border-brand focus:outline-none"
    >
      <option value="" disabled>
        {label}
      </option>
      {scripts.map((s) => (
        <option key={s.id} value={s.id}>
          {s.title}
        </option>
      ))}
    </select>
  );
}

/**
 * Step 1 on Edit: a big drop area for footage (many files at once; uploads resume after a dropped connection), then
 * any take that needs a decision about which script it belongs to.
 */
export function UploadZone({ takes, scripts, roomy, trialOn = true }: { takes: UploadView[]; scripts: TakeScript[]; roomy: boolean; trialOn?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const { items, add, retry, dismiss } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // "These are clean reels for trial reels": finished reels without captions or title, kept for trial reels.
  const [clean, setClean] = useState(false);

  const addFiles = (files: FileList | File[]) => {
    const n = add(files, clean ? { purpose: "trial" } : {});
    const where = clean ? "They wait under Trial reels below." : "Each one goes straight to your editor.";
    toast(n ? `Uploading ${n} ${n === 1 ? "video" : "videos"}. ${where}` : "Only video files can be uploaded (.mov, .mp4).", n ? "ok" : "error");
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    addFiles(e.dataTransfer.files);
  };

  const run = async (id: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
    setBusy(id);
    const r = await fn();
    setBusy(null);
    toast(r.ok ? r.message ?? "Done" : r.error ?? "That didn't work.", r.ok ? "ok" : "error");
    router.refresh();
  };
  const link = (u: UploadView, contentId: string | null, replace = false) => run(u.id, () => linkUploadAction(u.id, contentId, { replace }));

  // Uploads still on their way up (the server doesn't know them yet, or just finished).
  const known = new Set(takes.map((t) => t.id));
  const local = items.filter((it) => it.status !== "done" && !(it.result?.uploadId && known.has(it.result.uploadId)));

  return (
    <section aria-labelledby="edit-upload" className="flex flex-col gap-3">
      <h2 id="edit-upload" className="sr-only">
        Upload footage
      </h2>
      <div
        data-dropzone
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex rounded-lg border border-dashed transition-colors",
          roomy ? "flex-col items-center justify-center gap-3 px-6 py-12 text-center" : "items-center gap-4 px-4 py-4 max-sm:flex-col max-sm:items-start",
          over ? "border-brand bg-brand-tint/40" : "border-border-strong hover:border-fg-3",
        )}
      >
        <Upload className={cn("shrink-0 text-fg-3", roomy ? "size-7" : "size-5", over && "text-brand-fg")} strokeWidth={1.5} aria-hidden />
        <div className={cn("min-w-0", !roomy && "flex-1")}>
          <p className={cn("font-medium text-fg", roomy ? "text-h3" : "text-small")}>Drop your footage here</p>
          <p className={cn("text-fg-2", roomy ? "mx-auto mt-1 max-w-sm text-small" : "text-caption")}>
            {clean ? "Finished reels without captions or a title. They're kept for trial reels, not edited." : "As many videos as you like. Your editor matches each one to its script and starts cutting."}
          </p>
          {trialOn ? (
            <label className={cn("mt-2 inline-flex cursor-pointer items-center gap-2 text-caption text-fg-2", roomy && "justify-center")}>
              <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} className="accent-[var(--brand)]" data-testid="edit-upload-trial" />
              These are clean reels for trial reels
            </label>
          ) : null}
        </div>
        <Button variant={roomy ? "primary" : "secondary"} size={roomy ? "lg" : "md"} onClick={() => input.current?.click()} className={roomy ? "mt-1" : ""}>
          <Upload className="size-4" strokeWidth={1.75} /> Choose videos
        </Button>
        <input
          ref={input}
          type="file"
          accept="video/*,.mov,.mp4,.m4v,.webm,.mkv"
          multiple
          hidden
          data-testid="edit-upload-input"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {local.length || takes.length ? (
        <ul className="flex flex-col gap-2" aria-label="Uploads">
          {local.map((it) => (
            <li key={it.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-3">
              <Cover id={null} />
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
                      <div className="h-full rounded-full bg-brand transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct(it)}%` }} />
                    </div>
                    <p className="mt-1.5 text-caption text-fg-3 tabular">{it.status === "queued" ? "Waiting to upload" : it.status === "finishing" ? "Saving" : `${pct(it)}% of ${bytes(it.size)}`}</p>
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
            </li>
          ))}

          {takes.map((u) => {
            const best = u.candidates[0];
            const extra = u.status === "linked" && u.role === "take";
            return (
              <li key={u.id} className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 px-3 py-3" data-take={u.status}>
                <Cover id={u.coverId} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="truncate text-small font-medium text-fg" title={u.fileName}>
                      {u.fileName}
                    </span>
                    <span className="shrink-0 text-caption text-fg-3 tabular">{[clock(u.durationS), u.bytes ? bytes(u.bytes) : ""].filter(Boolean).join(" · ")}</span>
                  </p>
                  {u.status === "matching" ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-small text-fg-2">
                      <LoaderCircle className="size-3.5 animate-spin text-fg-3 motion-reduce:animate-none" strokeWidth={1.75} /> Listening for which script this is…
                    </p>
                  ) : extra ? (
                    <div className="mt-1.5">
                      <p className="text-small text-fg-2">
                        Another take of <span className="font-medium text-fg">“{u.contentTitle ?? "this script"}”</span>. Your editor is using the first one.
                      </p>
                      <div className="mt-2.5">
                        <Button size="sm" variant="secondary" disabled={busy === u.id} onClick={() => link(u, u.contentId, true)}>
                          Use this take instead
                        </Button>
                      </div>
                    </div>
                  ) : u.status === "suggested" && best ? (
                    <div className="mt-1.5">
                      <p className="text-small text-fg-2">
                        Sounds like <span className="font-medium text-fg">“{best.title}”</span>{" "}
                        <Badge tone={best.score >= 0.62 ? "success" : best.score >= 0.4 ? "warning" : "neutral"} className="ml-1 tabular">
                          {Math.round(best.score * 100)}%
                        </Badge>
                      </p>
                      {u.transcript ? <p className="mt-1 line-clamp-1 text-caption italic text-fg-3">“{u.transcript.slice(0, 140)}”</p> : null}
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="primary" disabled={busy === u.id} onClick={() => link(u, best.contentId)}>
                          Confirm
                        </Button>
                        <ScriptPicker scripts={scripts.filter((s) => s.id !== best.contentId)} label="Pick another script" onPick={(c) => link(u, c)} disabled={busy === u.id} />
                        <Button size="sm" variant="ghost" disabled={busy === u.id} onClick={() => link(u, null)}>
                          No script, just edit it
                        </Button>
                      </div>
                    </div>
                  ) : u.status === "failed" ? (
                    <p className="mt-1.5 flex items-start gap-1.5 text-small text-danger">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} /> {u.error ?? "This file can't be edited."}
                    </p>
                  ) : (
                    <div className="mt-1.5">
                      <p className="text-small text-fg-2">{u.error ?? "Couldn't tell which script this is."}</p>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        {scripts.length ? <ScriptPicker scripts={scripts} label="Pick the script" onPick={(c) => link(u, c)} disabled={busy === u.id} /> : null}
                        <Button size="sm" variant={scripts.length ? "ghost" : "primary"} disabled={busy === u.id} onClick={() => link(u, null)}>
                          No script, just edit it
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                {u.status !== "matching" ? (
                  <button
                    type="button"
                    onClick={() => run(u.id, () => dismissUploadAction(u.id))}
                    className="grid size-7 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg"
                    aria-label={`Remove ${u.fileName} from the list`}
                  >
                    <X className="size-4" strokeWidth={1.75} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

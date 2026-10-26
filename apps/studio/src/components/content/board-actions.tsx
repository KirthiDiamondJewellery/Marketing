"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Lightbulb, Upload } from "lucide-react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { createIdea, type ActionResult } from "@/server/actions/content";
import { Dialog } from "./dialog";
import { Toaster, toast } from "./toast";
import { FUNNEL_LABEL, humanize } from "./format";

type Option = { id: string; title: string; status: string };

/** The two things you start from in the Studio: an idea, or footage you just shot. */
export function BoardActions({ lanes, options, defaultContentId, primary = "idea" }: { lanes: string[]; options: Option[]; defaultContentId?: string; primary?: "idea" | "upload" }) {
  const [idea, setIdea] = useState(false);
  const [upload, setUpload] = useState(false);
  return (
    <>
      <Button variant={primary === "upload" ? "primary" : "secondary"} onClick={() => setUpload(true)}>
        <Upload className="size-4" strokeWidth={1.75} />
        Upload footage
      </Button>
      {primary === "idea" ? (
        <Button variant="primary" onClick={() => setIdea(true)}>
          <Lightbulb className="size-4" strokeWidth={1.75} />
          New idea
        </Button>
      ) : null}
      <NewIdeaDialog open={idea} onClose={() => setIdea(false)} lanes={lanes} />
      <UploadDialog open={upload} onClose={() => setUpload(false)} options={options} defaultContentId={defaultContentId} />
      <Toaster />
    </>
  );
}

function NewIdeaDialog({ open, onClose, lanes }: { open: boolean; onClose: () => void; lanes: string[] }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createIdea, null);
  useEffect(() => {
    if (state?.ok && state.id) {
      toast("Idea added. The Strategist will pick it up in the next plan.", { by: "Studio" });
      onClose();
      router.push(`/content/${state.id}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <Dialog open={open} onClose={onClose} title="New idea" description="Capture it now; the Strategist slots it into a lane and the Copywriter drafts the script.">
      <form action={action} className="flex flex-col gap-5">
        <Field label="Working title" htmlFor="idea-title" error={state && !state.ok ? state.message : null}>
          <Input id="idea-title" name="title" placeholder="Why we never quote from photos" required minLength={4} maxLength={140} autoComplete="off" />
        </Field>
        <Field label="Why now" htmlFor="idea-why" hint="Optional. What you saw or heard that made you think of it.">
          <Textarea id="idea-why" name="why" placeholder="Three people asked about this on last week's site visits" rows={3} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Lane" htmlFor="idea-lane">
            <Select id="idea-lane" name="lane" defaultValue="">
              <option value="">Let the Strategist pick</option>
              {lanes.map((l) => (
                <option key={l} value={l}>
                  {humanize(l)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Funnel stage" htmlFor="idea-funnel">
            <Select id="idea-funnel" name="funnel" defaultValue="">
              <option value="">Let the Strategist pick</option>
              {Object.entries(FUNNEL_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Angle" htmlFor="idea-angle" hint="Optional.">
          <Input id="idea-angle" name="angle" placeholder="The honest answer" autoComplete="off" />
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Adding…" : "Add idea"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function UploadDialog({ open, onClose, options, defaultContentId }: { open: boolean; onClose: () => void; options: Option[]; defaultContentId?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [contentId, setContentId] = useState(defaultContentId ?? "");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const xhr = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    if (!open) {
      xhr.current?.abort();
      setFile(null);
      setProgress(null);
      setError(null);
      setContentId(defaultContentId ?? "");
    }
  }, [open, defaultContentId]);

  const send = () => {
    if (!file) return;
    setError(null);
    setProgress(0);
    const req = new XMLHttpRequest();
    xhr.current = req;
    req.open("POST", "/api/media/upload");
    req.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    if (contentId) req.setRequestHeader("x-content-id", contentId);
    req.setRequestHeader("content-type", "application/octet-stream");
    req.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    req.onload = () => {
      let res: { ok: boolean; message: string; contentId?: string | null } = { ok: false, message: "The upload failed." };
      try {
        res = JSON.parse(req.responseText);
      } catch {
        // Not JSON (proxy error page, dropped connection): keep the "upload failed" default shown below.
      }
      if (req.status < 300 && res.ok) {
        toast(res.message, { by: "Art Director" });
        onClose();
        if (res.contentId) router.push(`/content/${res.contentId}#edit`);
        else router.refresh();
      } else {
        setProgress(null);
        setError(res.message);
      }
    };
    req.onerror = () => {
      setProgress(null);
      setError("The upload stopped. Check the connection to Studio and try again.");
    };
    req.send(file);
  };

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    if (!/\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name)) {
      setError("That isn't a video file. Phone recordings (.mov, .mp4) work.");
      return;
    }
    setError(null);
    setFile(f);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Upload footage" description="The Art Director preps it: proxy, transcript and a cut list for you to review.">
      <div className="flex flex-col gap-5">
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pick(e.dataTransfer.files[0]);
          }}
          className={`flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center transition-colors ${over ? "border-brand bg-brand-tint/40" : "border-border-strong hover:bg-surface-2"}`}
        >
          <Upload className="size-5 text-fg-2" strokeWidth={1.5} />
          {file ? (
            <>
              <span className="max-w-full truncate text-small font-medium text-fg">{file.name}</span>
              <span className="text-caption text-fg-3">{(file.size / 1024 ** 2).toFixed(1)} MB · click to choose another</span>
            </>
          ) : (
            <>
              <span className="text-small font-medium text-fg">Drop a take here, or choose a file</span>
              <span className="text-caption text-fg-3">.mov or .mp4, straight from your phone</span>
            </>
          )}
        </button>
        <input ref={input} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        <Field label="Which piece is it for?" htmlFor="upload-content" hint="The edit uses that piece's format and script.">
          <Select id="upload-content" value={contentId} onChange={(e) => setContentId(e.target.value)}>
            <option value="">Not linked to a piece yet</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title} ({o.status})
              </option>
            ))}
          </Select>
        </Field>
        {progress !== null ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <div className="relative h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="absolute inset-y-0 left-0 bg-brand transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="text-caption tabular text-fg-2">{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Filing it for the Art Director…"}</span>
          </div>
        ) : null}
        {error ? (
          <p className="text-small text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!file || progress !== null} onClick={send}>
            {progress !== null ? "Uploading…" : "Upload and prep"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

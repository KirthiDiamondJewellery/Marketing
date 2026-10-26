"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
import { Badge, Button, cn } from "@/components/ui";
import { fmtRelative } from "@/components/content/format";
import { toast, Toaster } from "@/components/content/toast";
import { saveBrandFile } from "@/server/actions/brand";
import type { BrandFileMeta } from "@/server/queries/brand";

/**
 * One Brand Kit file in a plain mono editor. YAML is checked against the Brand Kit rules on the server before it is
 * written; the file on disk stays the source of truth (taste lives in files).
 */
export function BrandEditor({ meta, initial, initialHash }: { meta: BrandFileMeta; initial: string; initialHash: string }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [hash, setHash] = useState(initialHash);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(meta.modifiedAt);
  const [unlocked, setUnlocked] = useState(meta.mode === "edit");
  const [pending, start] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  const dirty = value !== saved;
  const editable = meta.mode !== "read_only" && unlocked;
  const lines = value.split("\n").length;

  // A different file (or a fresh server read) resets the editor.
  useEffect(() => {
    setValue(initial);
    setSaved(initial);
    setHash(initialHash);
    setError(null);
    setSavedAt(meta.modifiedAt);
    setUnlocked(meta.mode === "edit");
  }, [meta.file, initial, initialHash, meta.modifiedAt, meta.mode]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = () => {
    if (!editable || !dirty || pending) return;
    start(async () => {
      const res = await saveBrandFile({ file: meta.file, content: value, baseHash: hash });
      if (res.ok) {
        setSaved(value);
        setHash(res.hash);
        setError(null);
        setSavedAt(res.savedAt);
        toast(res.message);
      } else {
        setError(res.error);
      }
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onTab = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey || !editable) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    const next = `${value.slice(0, s)}  ${value.slice(end)}`;
    setValue(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 2;
    });
  };

  return (
    <section aria-labelledby="brand-file-title" className="flex min-w-0 flex-col">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="brand-file-title" className="text-h2 font-medium text-fg">
              {meta.title}
            </h2>
            {meta.mode === "read_mostly" ? <Badge tone="neutral">Written by agents</Badge> : null}
            {meta.mode === "read_only" ? <Badge tone="neutral">Read only</Badge> : null}
            {dirty ? (
              <span className="inline-flex items-center gap-1.5 text-caption text-fg-2" role="status">
                <span aria-hidden className="size-1.5 rounded-full bg-brand" />
                Unsaved changes
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-small text-fg-2">{meta.description}</p>
          <p className="mt-1 text-caption text-fg-3">
            {meta.path}
            {savedAt ? ` · edited ${fmtRelative(savedAt)}` : " · not created yet"}
            {meta.kind === "yaml" ? " · checked against the Brand Kit rules before saving" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {meta.mode === "read_mostly" && !unlocked ? (
            <Button variant="secondary" onClick={() => setUnlocked(true)}>
              Edit anyway
            </Button>
          ) : null}
          {editable ? (
            <>
              <Button variant="ghost" onClick={() => { setValue(saved); setError(null); }} disabled={!dirty || pending} aria-label="Revert to the saved version">
                <RotateCcw className="size-4" aria-hidden />
                Revert
              </Button>
              <Button variant="primary" onClick={save} disabled={!dirty || pending}>
                {pending ? "Saving" : `Save ${meta.file.split("/").pop()}`}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {meta.mode === "read_mostly" && !unlocked ? (
        <p className="mt-4 rounded-md bg-surface-2 px-4 py-3 text-small text-fg-2">
          Agents add a dated rule here every time you correct their work. Edit it only to remove a rule that no longer holds.
        </p>
      ) : null}

      {error ? (
        <p id="brand-error" role="alert" className="mt-4 flex items-start gap-2 rounded-md bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-4 py-3 text-small text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{/[.!?]$/.test(error) ? error : `${error}.`} Nothing was saved.</span>
        </p>
      ) : null}
      <div className={cn("relative mt-5 overflow-hidden rounded-lg border bg-surface-1 transition-colors duration-[120ms] focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--brand-tint)]", error ? "border-danger" : "border-border")}>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onTab}
          readOnly={!editable}
          spellCheck={meta.kind === "md"}
          aria-label={`${meta.file} contents`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "brand-error" : undefined}
          className={cn(
            "block min-h-[52vh] w-full resize-y bg-transparent px-5 py-4 font-mono text-[13px] leading-[22px] text-fg outline-none md:min-h-[64vh]",
            !editable && "text-fg-2",
          )}
          style={{ tabSize: 2 }}
        />
        <div className="flex items-center justify-between border-t border-border px-5 py-2 text-caption text-fg-3">
          <span className="tabular">
            {lines} line{lines === 1 ? "" : "s"} · {value.length.toLocaleString("en-US")} characters
          </span>
          {editable ? <span className="hidden sm:inline">⌘S to save</span> : <span>{meta.mode === "read_only" ? "Edit this file in your workspace folder" : "Locked"}</span>}
        </div>
      </div>

      <Toaster />
    </section>
  );
}

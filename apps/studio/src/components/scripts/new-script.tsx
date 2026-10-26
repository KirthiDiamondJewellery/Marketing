"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PenLine, Sparkles, X } from "lucide-react";
import { askForScriptAction, createOwnScriptAction } from "@/server/actions/scripts";
import { Button, Input, Textarea, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";

export type NewMode = "ai" | "own";

/** "New script": two ways in. Ask the AI (one box), or write it yourself (title, hook, script). */
export function NewScriptPanel({ mode, onMode, onClose, onCreated }: { mode: NewMode; onMode: (m: NewMode) => void; onClose: () => void; onCreated: (id: string | undefined) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [ask, setAsk] = useState("");
  const [title, setTitle] = useState("");
  const [hook, setHook] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    setError(null);
  }, [mode]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = mode === "ai" ? await askForScriptAction(ask) : await createOwnScriptAction({ title, hook, body });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    toast(r.message ?? "Saved");
    setAsk("");
    setTitle("");
    setHook("");
    setBody("");
    onCreated(r.id);
    router.refresh();
  };

  const tab = (m: NewMode, label: string, Icon: typeof Sparkles) => (
    <button
      type="button"
      role="tab"
      id={`new-tab-${m}`}
      aria-selected={mode === m}
      aria-controls="new-script-panel"
      onClick={() => onMode(m)}
      className={cn(
        "flex h-9 items-center gap-2 rounded-md px-3 text-small font-medium transition-colors",
        mode === m ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
      {label}
    </button>
  );

  return (
    <section aria-label="New script" className="mb-8 rounded-lg border border-border bg-surface-1 p-5 max-sm:p-4">
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label="How to make it" className="flex flex-wrap gap-1">
          {tab("ai", "Ask the AI", Sparkles)}
          {tab("own", "Write it myself", PenLine)}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid size-9 place-items-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg">
          <X className="size-4" />
        </button>
      </div>

      <form
        id="new-script-panel"
        role="tabpanel"
        aria-labelledby={`new-tab-${mode}`}
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === "ai" ? (
          <>
            <label htmlFor="ask-ai" className="text-small font-medium text-fg">
              What do you want a script about?
            </label>
            <Textarea
              id="ask-ai"
              ref={first}
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
              }}
              placeholder="The topic, the angle, a story you want to tell, anything it should say or avoid"
              maxLength={1000}
              className="min-h-28"
            />
            <p className="text-caption text-fg-3">The AI writes it in your voice and it comes back here for your OK.</p>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="own-title" className="text-small font-medium text-fg">
                Title
              </label>
              <Input id="own-title" ref={first} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A few words so you can find it" maxLength={140} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="own-hook" className="text-small font-medium text-fg">
                Hook
              </label>
              <Input id="own-hook" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="The first line you say" maxLength={400} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="own-body" className="text-small font-medium text-fg">
                Script
              </label>
              <Textarea id="own-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Everything you say after the hook" maxLength={8000} className="min-h-40" />
            </div>
            <p className="text-caption text-fg-3">Saved as ready to film. No AI involved.</p>
          </>
        )}
        {error ? (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (mode === "ai" ? ask.trim().length < 8 : title.trim().length < 3 || (!body.trim() && !hook.trim()))}
            className="max-sm:flex-1"
          >
            {mode === "ai" ? (busy ? "Asking" : "Write it for me") : busy ? "Saving" : "Save script"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="max-sm:flex-1">
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}

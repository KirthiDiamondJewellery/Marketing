"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowUpRight, Bookmark, Loader2, Plus, Sparkles, X } from "lucide-react";
import { Button, Field, Input, Select, buttonClass, cn } from "@/components/ui";
import { toast } from "@/components/content/toast";
import { addCreator, remixOutlier, removeCreator, setCreatorTier, setTrendStatus } from "@/server/actions/research";
import { PLATFORM_LABEL } from "@/components/content/format";

export function RemixButton({ id, remixedAs }: { id: string; remixedAs: { id: string; title: string } | null }) {
  const [pending, start] = useTransition();
  const [made, setMade] = useState(remixedAs);
  const router = useRouter();
  if (made) {
    return (
      <Link href={`/content/${made.id}`} className={buttonClass("ghost", "sm", "-mr-2 text-fg-2")} title={made.title}>
        In your ideas
        <ArrowUpRight className="size-3.5" />
      </Link>
    );
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await remixOutlier(id);
          if (!res.ok) return toast(res.error, { tone: "error" });
          if (res.data) setMade(res.data);
          toast(res.message, { by: "Strategist" });
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
      Remix this
    </Button>
  );
}

export function TrendActions({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (next: "new" | "shortlisted" | "dismissed") =>
    start(async () => {
      const res = await setTrendStatus(id, next);
      if (!res.ok) return toast(res.error, { tone: "error" });
      toast(res.message);
      router.refresh();
    });
  if (status === "kit" || status === "used" || status === "expired") return null;
  if (status === "dismissed") {
    return (
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("new")}>
        Restore
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {status !== "shortlisted" ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run("shortlisted")}>
          <Bookmark className="size-3.5" />
          Shortlist
        </Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("new")}>
          Unshortlist
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("dismissed")} aria-label="Dismiss trend" title="Dismiss">
        <X className="size-4" />
      </Button>
    </div>
  );
}

const TIERS = [
  { key: "core", label: "Core" },
  { key: "adjacent", label: "Adjacent" },
  { key: "aspirational", label: "Aspirational" },
  { key: "remake", label: "Remake" },
];

export function TierSelect({ handle, platform, tier, disabled }: { handle: string; platform: string; tier: string; disabled?: boolean }) {
  const [value, setValue] = useState(tier);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <select
      aria-label={`Tier for ${handle}`}
      value={value}
      disabled={disabled || pending}
      onChange={(e) => {
        const next = e.target.value;
        const prev = value;
        setValue(next);
        start(async () => {
          const res = await setCreatorTier(handle, platform, next);
          if (!res.ok) {
            setValue(prev);
            return toast(res.error, { tone: "error" });
          }
          toast(res.message);
          router.refresh();
        });
      }}
      className="h-8 rounded-sm border border-transparent bg-transparent pl-2 pr-6 text-small text-fg outline-none transition-colors hover:border-border focus:border-brand disabled:opacity-60"
    >
      {TIERS.map((t) => (
        <option key={t.key} value={t.key}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

export function RemoveCreator({ handle, platform }: { handle: string; platform: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`Stop tracking ${handle}`} title="Stop tracking">
        <X className="size-4" />
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await removeCreator(handle, platform);
            if (!res.ok) return toast(res.error, { tone: "error" });
            toast(res.message);
            setConfirming(false);
            router.refresh();
          })
        }
      >
        Stop tracking
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}

export function AddCreatorForm({ platforms, primary = false }: { platforms: string[]; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!open) {
    return (
      <Button variant={primary ? "primary" : "secondary"} onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Track a creator
      </Button>
    );
  }
  return (
    <form
      className="grid w-full gap-4 rounded-lg border border-border bg-surface-1 p-5 sm:grid-cols-[1.2fr_1fr_1fr] lg:grid-cols-[1.2fr_0.9fr_0.9fr_1.6fr_auto] lg:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const res = await addCreator({
            handle: String(fd.get("handle") ?? ""),
            platform: String(fd.get("platform") ?? ""),
            tier: String(fd.get("tier") ?? "core"),
            notes: String(fd.get("notes") ?? ""),
          });
          if (!res.ok) return setError(res.error);
          toast(res.message, { by: "Analyst" });
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <Field label="Handle" htmlFor="cr-handle" error={error}>
        <Input id="cr-handle" name="handle" placeholder="@creator_handle" autoComplete="off" required autoFocus aria-invalid={error ? true : undefined} />
      </Field>
      <Field label="Platform" htmlFor="cr-platform">
        <Select id="cr-platform" name="platform" defaultValue={platforms[0] ?? "instagram"}>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p] ?? p}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Tier" htmlFor="cr-tier">
        <Select id="cr-tier" name="tier" defaultValue="core">
          {TIERS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Why track them" htmlFor="cr-notes">
        <Input id="cr-notes" name="notes" placeholder="Strong before-and-afters, short hooks" autoComplete="off" />
      </Field>
      <div className={cn("flex items-center gap-2 sm:col-span-3 lg:col-span-1")}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Track creator
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

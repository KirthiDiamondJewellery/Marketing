"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { noteSettingsApplying } from "@/lib/settings-apply";
import { saveKeyAction } from "@/server/actions/settings";
import type { SettingsData } from "./settings-view";

type Key = SettingsData["keys"][number];

export function KeysSection({ keys }: { keys: Key[] }) {
  return (
    <Card padded={false}>
      <ul className="divide-y divide-border">
        {keys.map((k) => (
          <KeyRow key={k.name} k={k} />
        ))}
      </ul>
    </Card>
  );
}

function KeyRow({ k }: { k: Key }) {
  const toast = useToast();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();

  const reset = () => {
    setEditing(false);
    setConfirming(false);
    setValue("");
  };
  const save = () =>
    start(async () => {
      const res = await saveKeyAction(k.name, value);
      if (res.ok) {
        if (res.applying) noteSettingsApplying();
        toast(res.message);
        reset();
        router.refresh();
      } else {
        toast(res.error, "error");
        setConfirming(false);
      }
    });

  return (
    <li className="px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-fg">{k.label}</span>
            <code className="font-mono text-caption text-fg-3">{k.name}</code>
          </div>
          <p className="text-small text-fg-2">{k.purpose}</p>
        </div>
        <div className="flex items-center gap-2">
          {k.set ? <Badge tone="success">{k.source === "environment" ? "Set in the environment" : "Set"}</Badge> : <Badge tone="neutral">Missing</Badge>}
          {k.editable && !editing ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              {k.set ? "Replace" : "Add key"}
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            if (!confirming) setConfirming(true);
            else save();
          }}
        >
          <label htmlFor={`key-${k.name}`} className="text-caption text-fg-3">
            Get it from: {k.where}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`key-${k.name}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setConfirming(false);
              }}
              placeholder={`Paste your ${k.label}`}
              className="font-mono"
            />
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button type="submit" disabled={!value.trim() || pending}>
                {pending ? "Saving…" : confirming ? "Yes, write it to .env" : "Save key"}
              </Button>
            </div>
          </div>
          {confirming ? (
            <p className="text-caption text-fg-2" role="status">
              This writes {k.name} to your workspace&apos;s .env file{k.set ? " and replaces the current value" : ""}.
              {k.source === "environment" ? " A value set in the environment still wins until you remove it there." : ""} Press the button again to confirm.
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

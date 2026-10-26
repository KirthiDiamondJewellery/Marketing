"use client";
import { useTransition } from "react";
import { RotateCcw, Square } from "lucide-react";
import { cancelRunAction, retryRunAction } from "@/server/actions/runs";
import { Button } from "@/components/ui";
import { useToast } from "@/components/shell/toast";

export function RunActions({ runId, status }: { runId: string; status: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const act = (fn: (id: string) => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      const r = await fn(runId);
      toast(r.ok ? r.message ?? "Done" : r.error ?? "Couldn't do that", r.ok ? "ok" : "error");
    });
  if (status === "queued" || status === "running" || status === "waiting_approval") {
    return (
      <Button variant="danger" disabled={pending} onClick={() => act(cancelRunAction)}>
        <Square className="size-3.5" strokeWidth={1.75} /> Stop this task
      </Button>
    );
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <Button variant="secondary" disabled={pending} onClick={() => act(retryRunAction)}>
        <RotateCcw className="size-4" strokeWidth={1.5} /> Try again
      </Button>
    );
  }
  return null;
}

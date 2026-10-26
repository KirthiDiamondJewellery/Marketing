"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useLive } from "@/lib/use-live";
import { takeSettingsApplying } from "@/lib/settings-apply";
import { useToast } from "./toast";

/** After a settings save restarts Studio, the live stream drops and reconnects: say the new settings are live. */
export function SettingsApplied() {
  const { connected } = useLive();
  const toast = useToast();
  const router = useRouter();
  const seen = useRef(false);
  const dropped = useRef(false);
  useEffect(() => {
    if (!connected) {
      if (seen.current) dropped.current = true;
      return;
    }
    seen.current = true;
    if (!dropped.current) return;
    dropped.current = false;
    if (takeSettingsApplying()) {
      toast("Your new settings are live");
      router.refresh();
    }
  }, [connected, toast, router]);
  return null;
}

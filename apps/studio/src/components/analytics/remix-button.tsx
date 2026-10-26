"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowUpRight, Loader2, Sparkles } from "lucide-react";
import { toast } from "@/components/content/toast";
import { Button, buttonClass } from "@/components/ui";
import { remixToScriptAction } from "@/server/actions/analytics";

/** "Remix this": the outlier becomes an idea in Scripts and the Copywriter starts the script. */
export function RemixButton({ id, remixedAs }: { id: string; remixedAs: { id: string; title: string } | null }) {
  const [pending, start] = useTransition();
  const [made, setMade] = useState(remixedAs);
  if (made) {
    return (
      <Link href="/scripts" className={buttonClass("ghost", "sm", "-mr-2 text-fg-2")} title={made.title}>
        In Scripts
        <ArrowUpRight className="size-3.5" aria-hidden />
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
          const res = await remixToScriptAction(id);
          if (!res.ok) return toast(res.error, { tone: "error" });
          if (res.data) setMade(res.data);
          toast(res.message, { by: "Strategist" });
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
      Remix this
    </Button>
  );
}

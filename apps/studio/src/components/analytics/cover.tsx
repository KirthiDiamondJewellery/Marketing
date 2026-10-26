"use client";
import { useState } from "react";
import { ThumbPlaceholder } from "@/components/content/shared";
import { cn } from "@/components/ui";

const ASPECT = { feed: "aspect-[4/5]", tall: "aspect-[9/16]", square: "aspect-square" } as const;

/**
 * A post's cover from the platform's CDN. Those links expire after a while, so a broken one quietly falls back to
 * the placeholder instead of a broken-image icon.
 */
export function Cover({ src, platform, className, aspect = "feed" }: { src: string | null; platform: string; className?: string; aspect?: keyof typeof ASPECT }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <ThumbPlaceholder platform={platform} className={cn(ASPECT[aspect], "w-full rounded-md", className)} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={cn(ASPECT[aspect], "w-full rounded-md bg-surface-2 object-cover", className)}
    />
  );
}

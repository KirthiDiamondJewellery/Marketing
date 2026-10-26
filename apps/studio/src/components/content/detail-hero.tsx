"use client";
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { PostAssembly } from "@/motion/PostAssembly";
import { Button } from "@/components/ui";

/**
 * Moment 3, post assembly, on the content hero. It plays when the script is fresh (the Copywriter just produced it),
 * and on demand; otherwise it rests in its end state.
 */
export function AssemblyHero({ image, caption, platform, score, fresh }: { image: string | null; caption: string; platform: string; score?: number; fresh: boolean }) {
  const [play, setPlay] = useState(fresh);
  return (
    <div className="flex flex-col items-center gap-3">
      <PostAssembly image={image} caption={caption} platform={platform} score={score} play={play} />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setPlay(false);
          requestAnimationFrame(() => setPlay(true));
        }}
      >
        <RotateCcw className="size-3.5" strokeWidth={1.75} />
        Replay assembly
      </Button>
    </div>
  );
}

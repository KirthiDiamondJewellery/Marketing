// Unfinished feature: an "Upload takes" button that uploads many videos and matches each to its script. Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import { useRef } from "react";
import { Upload } from "lucide-react";
import { Button, type ButtonVariant } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { useUploads } from "./upload-provider";

/** "Upload takes": pick many files at once; each is matched to its script after upload. */
export function UploadButton({ variant = "primary", label = "Upload takes" }: { variant?: ButtonVariant; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { add } = useUploads();
  const toast = useToast();
  return (
    <>
      <Button variant={variant} onClick={() => input.current?.click()}>
        <Upload className="size-4" strokeWidth={1.75} /> {label}
      </Button>
      <input
        ref={input}
        type="file"
        accept="video/*,.mov,.mp4,.m4v,.webm,.mkv"
        multiple
        hidden
        data-testid="upload-takes-input"
        onChange={(e) => {
          if (e.target.files) {
            const n = add(e.target.files);
            toast(n ? `Uploading ${n} ${n === 1 ? "take" : "takes"}. Each one is matched to its script.` : "Only video files can be uploaded (.mov, .mp4).", n ? "ok" : "error");
          }
          e.target.value = "";
        }}
      />
    </>
  );
}

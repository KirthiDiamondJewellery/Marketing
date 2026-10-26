import Link from "next/link";
import { FileCode2, FileText, Lock } from "lucide-react";
import { cn } from "@/components/ui";
import { fmtRelative } from "@/components/content/format";
import type { BrandFileMeta, BrandGroup } from "@/server/queries/brand";

const GROUPS: { id: BrandGroup; label: string }[] = [
  { id: "identity", label: "Who you are" },
  { id: "making", label: "What you make" },
  { id: "watching", label: "Where the team looks" },
  { id: "learning", label: "What the team has learned" },
];

export function BrandFileList({ files, selected }: { files: BrandFileMeta[]; selected: string }) {
  return (
    <nav aria-label="Brand Kit files" className="flex flex-col gap-6">
      {GROUPS.map((g) => {
        const items = files.filter((f) => f.group === g.id);
        if (!items.length) return null;
        return (
          <div key={g.id}>
            <h2 className="mb-1.5 px-3 text-caption text-fg-3">{g.label}</h2>
            <ul className="flex flex-col">
              {items.map((f) => {
                const active = f.file === selected;
                const Icon = f.mode === "read_only" ? Lock : f.kind === "yaml" ? FileCode2 : FileText;
                return (
                  <li key={f.file}>
                    <Link
                      href={`/brand?file=${encodeURIComponent(f.file)}`}
                      scroll={false}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex min-h-11 items-start gap-3 rounded-md px-3 py-2.5 transition-colors duration-[120ms]",
                        active ? "bg-surface-2" : "hover:bg-surface-2/60",
                      )}
                    >
                      <Icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-fg" : "text-fg-3")} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className={cn("truncate text-small", active ? "font-medium text-fg" : "text-fg")}>{f.title}</span>
                          <span className="shrink-0 text-caption text-fg-3">{f.exists ? fmtRelative(f.modifiedAt) : "Missing"}</span>
                        </span>
                        <span className="block truncate text-caption text-fg-3">{f.path}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

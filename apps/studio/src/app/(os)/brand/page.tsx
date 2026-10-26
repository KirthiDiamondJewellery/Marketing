import type { Metadata } from "next";
import { BRAND_FILES } from "@attentionos/core";
import { BrandEditor } from "@/components/brand/brand-editor";
import { BrandFileList } from "@/components/brand/file-list";
import { PageHeader } from "@/components/content/shared";
import { listBrandFiles, readBrandFile } from "@/server/queries/brand";

export const metadata: Metadata = { title: "Brand Kit" };
export const dynamic = "force-dynamic";

export default async function BrandPage({ searchParams }: { searchParams: Promise<{ file?: string }> }) {
  const sp = await searchParams;
  const files = listBrandFiles();
  const selected = files.some((f) => f.file === sp.file) ? sp.file! : BRAND_FILES.voice;
  const current = readBrandFile(selected);

  return (
    <>
      <PageHeader
        title="Brand Kit"
        description="Your taste, in plain files. Every agent reads these before it writes, edits or replies, and edits here save straight to your workspace."
      />
      <div className="grid gap-8 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-10">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <BrandFileList files={files} selected={selected} />
        </aside>
        {current ? <BrandEditor meta={current.meta} initial={current.content} initialHash={current.hash} /> : null}
      </div>
    </>
  );
}

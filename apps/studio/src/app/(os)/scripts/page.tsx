import type { Metadata } from "next";
import { getScriptsData } from "@/server/queries/scripts";
import { ScriptsView } from "@/components/scripts/scripts-view";

export const metadata: Metadata = { title: "Scripts" };
export const dynamic = "force-dynamic";

export default async function ScriptsPage({ searchParams }: { searchParams: Promise<{ open?: string | string[] }> }) {
  const [data, sp] = await Promise.all([getScriptsData(), searchParams]);
  const open = typeof sp.open === "string" ? sp.open : null;
  return (
    <div className="@container">
      <ScriptsView data={data} initialOpen={open} />
    </div>
  );
}

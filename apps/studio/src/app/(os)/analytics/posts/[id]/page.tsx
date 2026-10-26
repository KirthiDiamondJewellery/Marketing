import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnalyticsPostDetail } from "@/components/analytics/post-detail";
import { getPost } from "@/server/queries/analytics";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Post · Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getPost(id);
  if (!d) notFound();
  return <AnalyticsPostDetail d={d} tz={workspace().config.workspace.timezone} />;
}

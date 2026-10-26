import type { Metadata } from "next";
import { PostsTable } from "@/components/analytics/posts-table";
import { EmptyState } from "@/components/content/shared";
import { Segmented } from "@/components/insights/nav";
import { getPosts } from "@/server/queries/analytics";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Your posts · Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsPostsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days = sp.days === "7" ? 7 : sp.days === "30" ? 30 : sp.days === "90" ? 90 : null;
  const posts = await getPosts(days);
  const tz = workspace().config.workspace.timezone;
  const above = posts.filter((p) => p.versus === "above").length;
  const below = posts.filter((p) => p.versus === "below").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h2 font-medium text-fg">Your posts</h2>
          <p className="max-w-[68ch] text-small text-fg-2">
            {posts.length
              ? `${posts.length} post${posts.length === 1 ? "" : "s"}${days ? ` in the last ${days} days` : ""}: ${above} above your normal, ${below} below it. Your normal is your typical post on that platform.`
              : "No posts in this range."}
          </p>
        </div>
        <Segmented
          param="days"
          label="Time range"
          current={days ? String(days) : "all"}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      {posts.length ? (
        <PostsTable posts={posts} tz={tz} />
      ) : (
        <EmptyState title="No posts here yet" body="Pick a longer range, or finish setup so we can read your recent posts." />
      )}
    </div>
  );
}

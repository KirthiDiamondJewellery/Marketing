import type { Metadata } from "next";
import { getChat } from "@/server/queries/chat";
import { ChatThread } from "@/components/chat/chat-thread";
import { ChatHeader } from "@/components/chat/chat-header";

export const metadata: Metadata = { title: "Chief of Staff" };
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const chat = await getChat();
  return (
    <div className="-mb-12 flex h-[calc(100dvh-136px)] flex-col max-md:-mb-24 max-md:h-[calc(100dvh-56px-64px-40px)]">
      <ChatHeader />
      <div className="min-h-0 flex-1">
        <ChatThread initial={chat} />
      </div>
    </div>
  );
}

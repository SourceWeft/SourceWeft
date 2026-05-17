"use client";

import dynamic from "next/dynamic";
import { ChatRouteSkeleton } from "../../../_components/route-loading-skeleton";

const DashboardChatThreadPageClient = dynamic(
  () =>
    import("./dashboard-chat-thread-page-client").then(
      (mod) => mod.DashboardChatThreadPageClient,
    ),
  {
    loading: () => <ChatRouteSkeleton />,
    ssr: false,
  },
);

export default function DashboardChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  return <DashboardChatThreadPageClient params={params} />;
}

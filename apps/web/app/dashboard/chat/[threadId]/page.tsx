"use client";

import dynamic from "next/dynamic";

const DashboardChatThreadPageClient = dynamic(
  () =>
    import("./dashboard-chat-thread-page-client").then(
      (mod) => mod.DashboardChatThreadPageClient,
    ),
  {
    loading: () => null,
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

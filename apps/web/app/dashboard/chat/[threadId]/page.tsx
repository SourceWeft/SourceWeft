"use client";

import dynamic from "next/dynamic";

const DashboardChatThreadPageClient = dynamic(
  () =>
    import("./_thread/dashboard-chat-thread-page-root").then(
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

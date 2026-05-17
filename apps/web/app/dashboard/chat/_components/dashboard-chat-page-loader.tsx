"use client";

import dynamic from "next/dynamic";

const DashboardChatPageClient = dynamic(
  () =>
    import("./dashboard-chat-page-client").then(
      (mod) => mod.DashboardChatPageClient,
    ),
  {
    loading: () => <div className="min-h-0 flex-1 bg-background" />,
    ssr: false,
  },
);

export function DashboardChatPageLoader() {
  return <DashboardChatPageClient />;
}

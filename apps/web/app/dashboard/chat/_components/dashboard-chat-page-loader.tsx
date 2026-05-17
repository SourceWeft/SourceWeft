"use client";

import dynamic from "next/dynamic";
import { ChatRouteSkeleton } from "../../../_components/route-loading-skeleton";

const DashboardChatPageClient = dynamic(
  () =>
    import("./dashboard-chat-page-client").then(
      (mod) => mod.DashboardChatPageClient,
    ),
  {
    loading: () => <ChatRouteSkeleton />,
    ssr: false,
  },
);

export function DashboardChatPageLoader() {
  return <DashboardChatPageClient />;
}

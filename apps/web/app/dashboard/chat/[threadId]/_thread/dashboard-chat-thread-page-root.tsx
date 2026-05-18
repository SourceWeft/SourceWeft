"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { useDashboardChatState } from "../../../_components/dashboard-chat-state";
import { DashboardChatThreadPageView } from "./thread-page-view";
import { useThreadPageController } from "./use-thread-page-controller";

export function DashboardChatThreadPageClient({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const router = useRouter();
  const { threadId } = use(params);
  const controller = useThreadPageController({
    dashboardState: useDashboardChatState(),
    router,
    threadId,
  });

  return (
    <DashboardChatThreadPageView {...controller} />
  );
}


"use client";

import { useEffect } from "react";
import { ChatRouteRecovery } from "./_components/chat-route-recovery";
import { reportClientError } from "@/lib/client-error-diagnostics";

export default function ChatError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => reportClientError(error, "chat-route"), [error]);
  return <ChatRouteRecovery retry={retry} />;
}

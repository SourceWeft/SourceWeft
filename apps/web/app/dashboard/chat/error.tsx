"use client";

import { useEffect } from "react";
import { ChatErrorRecovery } from "@/app/_components/chat-error-recovery";
import { reportClientError } from "@/lib/client-error-diagnostics";

export default function ChatError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => reportClientError(error, "chat-route"), [error]);
  return <ChatErrorRecovery retry={retry} />;
}

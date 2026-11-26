"use client";

import { useEffect } from "react";
import { ChatRouteRecovery } from "./_components/chat-route-recovery";
import { reportClientError } from "@/lib/client-error-diagnostics";
import {
  isChunkLoadError,
  reloadForStaleBuild,
} from "@/lib/stale-build-reload";

export default function ChatError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "chat-route");
    // A script file that is gone means this page is from before a deploy;
    // trying again would ask for the same file.
    if (isChunkLoadError(error)) reloadForStaleBuild();
  }, [error]);
  return <ChatRouteRecovery retry={retry} />;
}

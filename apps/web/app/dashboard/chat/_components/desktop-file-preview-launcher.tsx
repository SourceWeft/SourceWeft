"use client";

import { useEffect, useRef, useState } from "react";
import type { PreviewSource } from "@sourceweft/preview";
import { toast } from "sonner";
import { openDesktopPreview } from "../../../../lib/desktop-preview-bridge";

/** Capture authorized file bytes before opening; never silently fall back to an inline reader. */
export function DesktopFilePreviewLauncher({
  open,
  source,
  loading,
  error,
  description,
  onOpened,
  onRetry,
}: {
  open: boolean;
  source?: PreviewSource;
  loading: boolean;
  error?: string;
  description: string;
  onOpened: () => void;
  onRetry?: () => void;
}) {
  const callbacks = useRef({ onOpened, onRetry });
  callbacks.current = { onOpened, onRetry };
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const notification = toast.loading("Opening preview window…");
    const fail = (message: string) =>
      toast.error(message, {
        id: notification,
        action: {
          label: "Try again",
          onClick: () => {
            callbacks.current.onRetry?.();
            setAttempt((value) => value + 1);
          },
        },
      });
    if (error) fail(error);
    else if (!loading && source) {
      void openDesktopPreview(source, description, controller.signal)
        .then(() => {
          if (!controller.signal.aborted) {
            toast.dismiss(notification);
            callbacks.current.onOpened();
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            fail(cause instanceof Error ? cause.message : String(cause));
        });
    }
    return () => {
      controller.abort();
      toast.dismiss(notification);
    };
    // Depend on the source values; listing refreshes may recreate its wrapper.
  }, [
    open,
    loading,
    error,
    description,
    source?.name,
    source?.mimeType,
    source?.blob,
    source?.text,
    source?.url,
    attempt,
  ]);
  return null;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SOURCEWEFT_WEB_RUN_STOP_SUFFIX } from "@sourceweft/sdk";
import { dispatchDashboardBillingSummaryRefresh } from "../../_components/dashboard-billing-summary-refresh";

export type ActiveThreadRun = {
  id?: string;
  idempotencyKey: string;
  status: "queued" | "running" | "cancel_requested";
  mode?: "send" | "refresh" | "edit";
  userMessageId?: string | null;
  assistantMessageId?: string | null;
};

type StreamRequestErrorHandler = (response: Response) => Promise<never>;

type ChatStreamRunnerControlOptions = {
  getDisplayErrorMessage: (error: unknown) => string;
  threadId: string;
  throwStreamRequestError: StreamRequestErrorHandler;
  workspaceId: string | null | undefined;
};

export function useChatStreamRunnerControl({
  getDisplayErrorMessage,
  threadId,
  throwStreamRequestError,
  workspaceId,
}: ChatStreamRunnerControlOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [activeThreadRun, setActiveThreadRun] =
    useState<ActiveThreadRun | null>(null);
  const activeThreadRunRef = useRef<ActiveThreadRun | null>(null);
  const attachedRunKeyRef = useRef<string | null>(null);

  useEffect(() => {
    activeThreadRunRef.current = activeThreadRun;
  }, [activeThreadRun]);

  const markRunStarted = useCallback(
    (run: ActiveThreadRun) => {
      setIsStreaming(true);
      setActiveThreadRun(run);
    },
    [setActiveThreadRun],
  );

  const clearAttachedRunKeyIfCurrent = useCallback((durableRunKey: string) => {
    attachedRunKeyRef.current =
      attachedRunKeyRef.current === durableRunKey
        ? null
        : attachedRunKeyRef.current;
  }, []);

  const clearRunIfCurrent = useCallback((durableRunKey: string) => {
    setActiveThreadRun((current) =>
      current?.idempotencyKey === durableRunKey ? null : current,
    );
  }, []);

  const markRunTerminal = useCallback(
    (input: { detachedWithoutFinish: boolean; durableRunKey: string }) => {
      if (!input.detachedWithoutFinish) {
        setIsStreaming(false);
        setIsStopping(false);
        clearRunIfCurrent(input.durableRunKey);
        dispatchDashboardBillingSummaryRefresh({
          reason: "chat-turn-terminal",
        });
      } else {
        setIsStopping(false);
      }
    },
    [clearRunIfCurrent],
  );

  const stopStreaming = useCallback(() => {
    const run = activeThreadRunRef.current;
    if (!workspaceId || !run || isStopping) {
      return;
    }

    setIsStopping(true);
    setActiveThreadRun({
      ...run,
      status: "cancel_requested",
    });
    void fetch(
      `${apiBaseUrl}/v1/workspaces/${workspaceId}/threads/${threadId}/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          idempotencyKey: `${run.idempotencyKey}${SOURCEWEFT_WEB_RUN_STOP_SUFFIX}`,
          stream: false,
        }),
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          await throwStreamRequestError(response);
        }
      })
      .catch((error) => {
        toast.error(getDisplayErrorMessage(error));
        setIsStopping(false);
        setActiveThreadRun((current) =>
          current?.idempotencyKey === run.idempotencyKey ? run : current,
        );
      });
  }, [
    getDisplayErrorMessage,
    isStopping,
    threadId,
    throwStreamRequestError,
    workspaceId,
  ]);

  return {
    activeThreadRun,
    attachedRunKeyRef,
    clearAttachedRunKeyIfCurrent,
    clearRunIfCurrent,
    isStopping,
    isStreaming,
    markRunStarted,
    markRunTerminal,
    setActiveThreadRun,
    stopStreaming,
  };
}

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

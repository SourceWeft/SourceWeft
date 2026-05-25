"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SOURCEWEFT_WEB_RUN_STOP_SUFFIX } from "@sourceweft/sdk";
import { dispatchDashboardBillingSummaryRefresh } from "../../_components/dashboard-billing-summary-refresh";

export type ActiveThreadRun = {
  id?: string;
  idempotencyKey: string;
  status:
    | "queued"
    | "running"
    | "cancel_requested"
    | "waiting_for_approval";
  mode?: "send" | "refresh" | "edit" | "resume";
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  approvalRequestedAt?: string | null;
  approvalExpiresAt?: string | null;
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

  const updateActiveRunIfCurrent = useCallback(
    (
      durableRunKey: string,
      updater: (run: ActiveThreadRun) => ActiveThreadRun,
    ) => {
      setActiveThreadRun((current) =>
        current?.idempotencyKey === durableRunKey ? updater(current) : current,
      );
    },
    [],
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

  const markRunStopped = useCallback(
    (durableRunKey: string) => {
      setIsStreaming(false);
      setIsStopping(false);
      clearRunIfCurrent(durableRunKey);
      clearAttachedRunKeyIfCurrent(durableRunKey);
      dispatchDashboardBillingSummaryRefresh({
        reason: "chat-turn-terminal",
      });
    },
    [clearAttachedRunKeyIfCurrent, clearRunIfCurrent],
  );

  const markRunTerminal = useCallback(
    (input: {
      detachedWithoutFinish: boolean;
      durableRunKey: string;
      waitingForApproval?: boolean;
    }) => {
      if (!input.detachedWithoutFinish) {
        setIsStreaming(false);
        setIsStopping(false);
        if (input.waitingForApproval) {
          setActiveThreadRun((current) =>
            current?.idempotencyKey === input.durableRunKey
              ? {
                  ...current,
                  status: "waiting_for_approval",
                }
              : current,
          );
        } else {
          clearRunIfCurrent(input.durableRunKey);
        }
        dispatchDashboardBillingSummaryRefresh({
          reason: "chat-turn-terminal",
        });
      } else {
        if (
          activeThreadRunRef.current?.idempotencyKey === input.durableRunKey &&
          activeThreadRunRef.current.status === "cancel_requested"
        ) {
          setIsStreaming(false);
          clearRunIfCurrent(input.durableRunKey);
          clearAttachedRunKeyIfCurrent(input.durableRunKey);
          dispatchDashboardBillingSummaryRefresh({
            reason: "chat-turn-terminal",
          });
        }
        setIsStopping(false);
      }
    },
    [clearAttachedRunKeyIfCurrent, clearRunIfCurrent],
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
        markRunStopped(run.idempotencyKey);
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
    markRunStopped,
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
    updateActiveRunIfCurrent,
  };
}

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

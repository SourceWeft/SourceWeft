"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { requestThreadRunStop } from "@/lib/stop-thread-run";
import { dispatchDashboardBillingSummaryRefresh } from "../../_components/dashboard-billing-summary-refresh";

export type ActiveThreadRun = {
  id?: string;
  idempotencyKey: string;
  status: "queued" | "running" | "cancel_requested" | "waiting_for_approval";
  mode?: "send" | "refresh" | "edit" | "resume";
  // Initiator of the run. Absent on optimistic local runs until the server
  // summary arrives; treated as "mine" when absent (see resolveActiveRunIsMine).
  userId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  approvalRequestedAt?: string | null;
  approvalExpiresAt?: string | null;
};

export type ChatExecutionState =
  "idle" | "executing" | "waiting_for_approval" | "stopping";

type StreamRequestErrorHandler = (response: Response) => Promise<never>;

type ChatStreamRunnerControlOptions = {
  getDisplayErrorMessage: (error: unknown) => string;
  threadId: string;
  throwStreamRequestError: StreamRequestErrorHandler;
  workspaceId: string | null | undefined;
};

export function resolveChatExecutionState(input: {
  activeThreadRun: ActiveThreadRun | null;
  isStopping: boolean;
}): ChatExecutionState {
  if (
    input.isStopping ||
    input.activeThreadRun?.status === "cancel_requested"
  ) {
    return "stopping";
  }
  if (input.activeThreadRun?.status === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (input.activeThreadRun) {
    return "executing";
  }
  return "idle";
}

/**
 * Whether the active run belongs to another member (followed live, never
 * stoppable from here). An unattributed run is treated as ours. While the
 * session is still loading the current user id is unknown, so a run is treated
 * as possibly ours and Stop stays visible: the stop endpoint authorizes
 * server-side, and hiding Stop during session load would strand our own run
 * after a reload. Once the session has settled, a missing user id (signed out
 * or the session read failed) no longer counts as "possibly ours".
 */
export function resolveOtherUserRunActive(input: {
  activeThreadRun: ActiveThreadRun | null;
  currentUserId: string | null | undefined;
  sessionPending: boolean;
}): boolean {
  const runUserId = input.activeThreadRun?.userId;
  if (runUserId == null) {
    return false;
  }
  if (input.currentUserId == null) {
    return !input.sessionPending;
  }
  return runUserId !== input.currentUserId;
}

export function resolveWaitingForApprovalRun(input: {
  assistantMessageId?: string | null;
  current: ActiveThreadRun | null;
  durableRunKey: string;
  mode?: ActiveThreadRun["mode"];
  threadRunId?: string | null;
}): ActiveThreadRun | null {
  if (input.current && input.current.idempotencyKey !== input.durableRunKey) {
    return input.current;
  }

  return {
    ...(input.current ?? {}),
    idempotencyKey: input.durableRunKey,
    ...(input.threadRunId ? { id: input.threadRunId } : {}),
    assistantMessageId:
      input.assistantMessageId ?? input.current?.assistantMessageId ?? null,
    ...((input.mode ?? input.current?.mode)
      ? { mode: input.mode ?? input.current?.mode }
      : {}),
    status: "waiting_for_approval",
  };
}

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
  const chatExecutionState = resolveChatExecutionState({
    activeThreadRun,
    isStopping,
  });
  const activeThreadRunRef = useRef<ActiveThreadRun | null>(null);
  const attachedRunKeyRef = useRef<string | null>(null);
  // Mirrors isStreaming for reads inside effects/callbacks (e.g. the room hook,
  // which must know whether THIS tab drives a run's token stream).
  const isStreamingRef = useRef(isStreaming);

  useEffect(() => {
    activeThreadRunRef.current = activeThreadRun;
  }, [activeThreadRun]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

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

  const clearTerminalLocalRunState = useCallback(() => {
    setIsStreaming(false);
    setIsStopping(false);
    setActiveThreadRun(null);
    attachedRunKeyRef.current = null;
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
      // An attach-only stream failed in transport while the run itself may
      // still be executing server-side. Keep the active run (and Stop), release
      // the attach slot so it can be re-attached; recovery reconciles it.
      attachFailed?: boolean;
      detachedWithoutFinish: boolean;
      durableRunKey: string;
      waitingForApproval?: boolean;
    }) => {
      if (input.attachFailed) {
        setIsStreaming(false);
        clearAttachedRunKeyIfCurrent(input.durableRunKey);
        return;
      }
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

  // Settles once the stop request has finished, so a caller can reload the
  // thread after the server has recorded the cancellation.
  const stopStreaming = useCallback(async () => {
    const run = activeThreadRunRef.current;
    if (!workspaceId || !run || isStopping) {
      return;
    }

    setIsStopping(true);
    setActiveThreadRun({
      ...run,
      status: "cancel_requested",
    });
    await requestThreadRunStop(workspaceId, threadId, run.idempotencyKey)
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
    activeThreadRunRef,
    attachedRunKeyRef,
    isStreamingRef,
    chatExecutionState,
    clearTerminalLocalRunState,
    clearAttachedRunKeyIfCurrent,
    clearRunIfCurrent,
    isStopping,
    isStreaming,
    markRunStarted,
    markRunStopped,
    markRunTerminal,
    setActiveThreadRun,
    stopStreaming,
    updateActiveRunIfCurrent,
  };
}

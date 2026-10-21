"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { contentClient } from "../../../../../lib/sdk";
import type { ActiveThreadRun } from "../chat-stream-runner-control";
import { createAttachReattachScheduler } from "./attach-reattach";
import type { ThreadMessagesLoadResult } from "./use-thread-messages";

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

type UseAttachReattachInput = {
  activeThreadRunRef: RefObject<ActiveThreadRun | null>;
  displayStreamError: (error: unknown) => string;
  loadThreadMessages: () => Promise<ThreadMessagesLoadResult | void>;
  markRunStopped: (runKey: string) => void;
  stopRunStreaming: () => Promise<void>;
  threadId: string;
  workspaceId: string | null | undefined;
};

/**
 * Page wiring for attach-failure recovery (see attach-reattach.ts): a failed
 * re-attach after a reload reconciles with the server's active run and
 * re-attaches through the reload path, or settles the ended run. The scheduler
 * is created once; its deps read the latest page state through a ref. Thread
 * change, unmount and a user Stop cancel any pending reattach.
 */
export function useAttachReattach(input: UseAttachReattachInput) {
  const latestRef = useRef(input);
  useBrowserLayoutEffect(() => {
    latestRef.current = input;
  });
  const [attachReattach] = useState(() =>
    createAttachReattachScheduler({
      getActiveRun: async () => {
        const { threadId, workspaceId } = latestRef.current;
        if (!workspaceId) {
          return null;
        }
        const result = await contentClient.getActiveThreadRun(
          workspaceId,
          threadId,
        );
        return result.threadRun ?? null;
      },
      isRunCurrent: (runKey) => {
        const run = latestRef.current.activeThreadRunRef.current;
        return (
          run?.idempotencyKey === runKey && run.status !== "cancel_requested"
        );
      },
      reattach: async () => {
        // The reload path re-reads the run + persisted messages and attaches
        // (or adopts an approval wait) exactly as a page reload does. A load
        // that gave up never started an attach, so it spends an attempt.
        const result = await latestRef.current.loadThreadMessages();
        return result !== "failed";
      },
      settleEndedRun: (runKey) => {
        const latest = latestRef.current;
        latest.markRunStopped(runKey);
        void latest.loadThreadMessages();
      },
      onGiveUp: (_runKey, error) => {
        toast.error(latestRef.current.displayStreamError(error));
      },
    }),
  );

  const { threadId, workspaceId, stopRunStreaming } = input;
  useEffect(
    () => () => attachReattach.cancelAll(),
    [attachReattach, threadId, workspaceId],
  );

  // A user stop owns the run from here: drop any pending reattach first.
  const handleStopStreaming = useCallback(() => {
    attachReattach.cancelAll();
    return stopRunStreaming();
  }, [attachReattach, stopRunStreaming]);

  return { attachReattach, handleStopStreaming };
}

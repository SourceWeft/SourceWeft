"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import type {
  ActiveThreadRun,
} from "../chat-stream-runner-control";
import {
  useStreamingAssistantTransientState,
  type ChatMessageItem,
} from "../streaming-assistant-state";
import { contentClient } from "../../../../../lib/sdk";
import {
  createActiveThreadRunPlaceholder,
  dropStaleActiveThreadRunMessages,
  findActiveThreadRunMessage,
  mapThreadMessagesToChatMessages,
  shouldRetryThreadMessagesLoad,
  THREAD_MESSAGES_INITIAL_PAGE_SIZE,
  THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS,
  waitForThreadMessagesRetry,
} from "./message-normalizers";
import type {
  ThreadStreamActionInput,
} from "./use-thread-stream-action";

type UseThreadMessagesInput = {
  attachedRunKeyRef: RefObject<string | null>;
  clearTerminalLocalRunState: () => void;
  setActiveThreadRun: (run: ActiveThreadRun | null) => void;
  streamThreadActionRef: RefObject<
    ((input: ThreadStreamActionInput) => Promise<void>) | null
  >;
  threadId: string;
  workspaceId: string | null;
};

function normalizeActiveThreadRun(run: ActiveThreadRun): ActiveThreadRun {
  return {
    ...run,
    approvalRequestedAt: run.approvalRequestedAt ?? null,
    approvalExpiresAt: run.approvalExpiresAt ?? null,
  };
}

export function useThreadMessages({
  attachedRunKeyRef,
  clearTerminalLocalRunState,
  setActiveThreadRun,
  streamThreadActionRef,
  threadId,
  workspaceId,
}: UseThreadMessagesInput) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const {
    mergeStreamingAssistantIntoMessages,
    setStreamingAssistantSnapshot,
  } = useStreamingAssistantTransientState();
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(
    null,
  );
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const loadedThreadMessagesKeyRef = useRef<string | null>(null);
  const threadMessagesLoadGenerationRef = useRef(0);

  const loadThreadMessages = useCallback(async () => {
    const loadGeneration = threadMessagesLoadGenerationRef.current + 1;
    threadMessagesLoadGenerationRef.current = loadGeneration;

    if (!workspaceId) {
      loadedThreadMessagesKeyRef.current = null;
      setMessages([]);
      setStreamingAssistantSnapshot(null);
      clearTerminalLocalRunState();
      setOlderMessagesCursor(null);
      return;
    }

    const threadMessagesKey = `${workspaceId}:${threadId}`;

    for (
      let attempt = 0;
      attempt <= THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        const [messagesResult, activeRunResult] = await Promise.all([
          contentClient.listThreadMessages(workspaceId, threadId, {
            include: "metadata,contentJson,citations",
            limit: THREAD_MESSAGES_INITIAL_PAGE_SIZE,
          }),
          contentClient.getActiveThreadRun(workspaceId, threadId),
        ]);
        let serverMessages = mapThreadMessagesToChatMessages(
          messagesResult.items,
        );
        const activeRun = activeRunResult.threadRun;

        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }

        loadedThreadMessagesKeyRef.current = threadMessagesKey;
        setOlderMessagesCursor(messagesResult.nextCursor ?? null);
        const runningRun = activeRun ? normalizeActiveThreadRun(activeRun) : null;
        let runningAssistant:
          | { message: ChatMessageItem; run: ActiveThreadRun }
          | null = findActiveThreadRunMessage(serverMessages, runningRun);
        const matchedRunningAssistant = runningAssistant;
        if (runningRun && !runningAssistant) {
          const latestUserMessage = [...serverMessages]
            .reverse()
            .find((message) => message.role === "user");
          const placeholder = createActiveThreadRunPlaceholder({
            run: runningRun,
            latestUserMessageId: latestUserMessage?.id ?? null,
          });
          serverMessages = [...serverMessages, placeholder];
          runningAssistant = { message: placeholder, run: runningRun };
        }
        const resolvedRunningRun = matchedRunningAssistant?.run ?? runningRun;
        setActiveThreadRun(resolvedRunningRun);
        setMessages(serverMessages);
        setStreamingAssistantSnapshot(null);
        if (!resolvedRunningRun) {
          clearTerminalLocalRunState();
        }
        if (
          resolvedRunningRun &&
          resolvedRunningRun.status !== "waiting_for_approval" &&
          runningAssistant &&
          resolvedRunningRun.idempotencyKey !== attachedRunKeyRef.current
        ) {
          attachedRunKeyRef.current = resolvedRunningRun.idempotencyKey;
          void streamThreadActionRef.current?.({
            mode: resolvedRunningRun.mode ?? "send",
            durableRunKey: resolvedRunningRun.idempotencyKey,
            attachOnly: true,
            assistantMessageId: runningAssistant.message.id,
            baseMessages: serverMessages,
          });
        }
        return;
      } catch (error) {
        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }

        const retryDelay = THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || !shouldRetryThreadMessagesLoad(error)) {
          if (loadedThreadMessagesKeyRef.current !== threadMessagesKey) {
            setMessages([]);
            setStreamingAssistantSnapshot(null);
            setOlderMessagesCursor(null);
          }
          return;
        }

        await waitForThreadMessagesRetry(retryDelay);
        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }
      }
    }
  }, [
    attachedRunKeyRef,
    clearTerminalLocalRunState,
    setActiveThreadRun,
    setStreamingAssistantSnapshot,
    streamThreadActionRef,
    threadId,
    workspaceId,
  ]);

  const loadOlderThreadMessages = useCallback(async () => {
    if (!workspaceId || !olderMessagesCursor || isLoadingOlderMessages) {
      return;
    }

    setIsLoadingOlderMessages(true);
    try {
      const result = await contentClient.listThreadMessages(
        workspaceId,
        threadId,
        {
          cursor: olderMessagesCursor,
          include: "metadata,contentJson,citations",
          limit: THREAD_MESSAGES_INITIAL_PAGE_SIZE,
        },
      );
      const olderMessages = mapThreadMessagesToChatMessages(result.items);
      setMessages((current) => {
        const mergedById = new Map(
          [...olderMessages, ...current].map((message) => [
            message.id,
            message,
          ]),
        );
        return dropStaleActiveThreadRunMessages(
          Array.from(mergedById.values()).sort(
            (left, right) =>
              new Date(left.createdAt).getTime() -
              new Date(right.createdAt).getTime(),
          ),
        );
      });
      setOlderMessagesCursor(result.nextCursor ?? null);
    } catch {
      toast.error("Failed to load earlier messages.");
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }, [isLoadingOlderMessages, olderMessagesCursor, threadId, workspaceId]);

  return {
    isLoadingOlderMessages,
    loadOlderThreadMessages,
    loadThreadMessages,
    mergeStreamingAssistantIntoMessages,
    messages,
    olderMessagesCursor,
    setMessages,
    setStreamingAssistantSnapshot,
  };
}

"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import type { ActiveThreadRun } from "../chat-stream-runner-control";
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
  newestServerCursor,
  shouldRetryThreadMessagesLoad,
  THREAD_MESSAGES_INITIAL_PAGE_SIZE,
  THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS,
  waitForThreadMessagesRetry,
} from "./message-normalizers";
import {
  findArtifactOutputMessage,
  mergeCommittedArtifactOutputsIntoMessages,
  mergeCommittedArtifactOutputsIntoStreamingSnapshot,
  type ArtifactOutputReconcileTarget,
} from "./artifact-output-reconcile";

// Caps a reconnect/gap catch-up; a larger gap is finished by the next frame.
const MAX_INCREMENTAL_DRAIN_PAGES = 10;
import type { ThreadStreamActionInput } from "./use-thread-stream-action";

type UseThreadMessagesInput = {
  activeThreadRunRef: RefObject<ActiveThreadRun | null>;
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
  activeThreadRunRef,
  attachedRunKeyRef,
  clearTerminalLocalRunState,
  setActiveThreadRun,
  streamThreadActionRef,
  threadId,
  workspaceId,
}: UseThreadMessagesInput) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const { mergeStreamingAssistantIntoMessages, setStreamingAssistantSnapshot } =
    useStreamingAssistantTransientState();
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(
    null,
  );
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const loadedThreadMessagesKeyRef = useRef<string | null>(null);
  const threadMessagesLoadGenerationRef = useRef(0);
  // Forward-cursor watermark of the newest RAW server message rendered, used to
  // incrementally append newer messages on a room 'message' frame instead of
  // replacing the whole list. Sourced only from server responses.
  const newestMessageCursorRef = useRef<string | null>(null);
  const isAppendingRef = useRef(false);

  const reconcileCommittedArtifactOutputs = useCallback(
    async (target: ArtifactOutputReconcileTarget) => {
      if (!workspaceId || (!target.assistantMessageId && !target.runId)) {
        return;
      }
      const loadGeneration = threadMessagesLoadGenerationRef.current;
      try {
        // The forward cursor only discovers newly-created rows. Artifact output
        // updates an existing assistant message, so fetch the bounded newest
        // page and merge only its immutable committed blocks into local state.
        const result = await contentClient.listThreadMessages(
          workspaceId,
          threadId,
          {
            include: "metadata,contentJson,citations",
            limit: THREAD_MESSAGES_INITIAL_PAGE_SIZE,
          },
        );
        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }
        const authoritative = findArtifactOutputMessage({
          messages: mapThreadMessagesToChatMessages(result.items),
          target,
        });
        if (!authoritative) {
          return;
        }
        setMessages((current) =>
          mergeCommittedArtifactOutputsIntoMessages({
            authoritative,
            current,
            target,
          }),
        );
        setStreamingAssistantSnapshot((current) =>
          mergeCommittedArtifactOutputsIntoStreamingSnapshot({
            authoritative,
            current,
            target,
          }),
        );
      } catch {
        // NotifyHub is a wake-up, not the source of truth. The next room
        // heartbeat/resync/terminal reconcile retries this bounded REST read.
      }
    },
    [setStreamingAssistantSnapshot, threadId, workspaceId],
  );

  const loadThreadMessages = useCallback(async () => {
    const loadGeneration = threadMessagesLoadGenerationRef.current + 1;
    threadMessagesLoadGenerationRef.current = loadGeneration;

    if (!workspaceId) {
      loadedThreadMessagesKeyRef.current = null;
      newestMessageCursorRef.current = null;
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
        // Watermark from the raw server page (the newest 80), never from
        // rendered/optimistic messages.
        newestMessageCursorRef.current = newestServerCursor(
          messagesResult.items,
        );
        setOlderMessagesCursor(messagesResult.nextCursor ?? null);
        const runningRun = activeRun
          ? normalizeActiveThreadRun(activeRun)
          : null;
        let runningAssistant: {
          message: ChatMessageItem;
          run: ActiveThreadRun;
        } | null = findActiveThreadRunMessage(serverMessages, runningRun);
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
            // Keep the run attributed to its initiator so following another
            // member's run does not lock our composer (owner-aware gating).
            runOwnerUserId: resolvedRunningRun.userId ?? null,
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

  // Incremental forward sync: on a room 'message' frame, append messages newer
  // than the watermark instead of replacing the whole list. Idle-only (the
  // caller gates on no active run), single-flight, bounded, generation-guarded,
  // with a full-reload fallback. No watermark yet → fall back to a full load.
  const appendNewerThreadMessages = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    // Idle-only: never merge into the list while a run is active (an optimistic
    // send in flight), or a committed server copy could duplicate/reorder the
    // temp rows until stream reconciliation. The next post-run frame re-drains.
    if (activeThreadRunRef.current != null) {
      return;
    }
    const cursor = newestMessageCursorRef.current;
    if (!cursor) {
      await loadThreadMessages();
      return;
    }
    if (isAppendingRef.current) {
      return;
    }
    isAppendingRef.current = true;
    const loadGeneration = threadMessagesLoadGenerationRef.current;
    try {
      let after = cursor;
      for (let page = 0; page < MAX_INCREMENTAL_DRAIN_PAGES; page += 1) {
        const result = await contentClient.listThreadMessages(
          workspaceId,
          threadId,
          {
            after,
            include: "metadata,contentJson,citations",
            limit: THREAD_MESSAGES_INITIAL_PAGE_SIZE,
          },
        );
        // A thread switch (or full reload) superseded us mid-drain.
        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }
        // A run started mid-drain: bail WITHOUT advancing the watermark so the
        // unmerged page re-drains once idle again (advancing + skipping the
        // merge would drop those messages until a full reload).
        if (activeThreadRunRef.current != null) {
          return;
        }
        if (result.items.length === 0) {
          break;
        }
        const nextWatermark = newestServerCursor(result.items);
        if (nextWatermark) {
          newestMessageCursorRef.current = nextWatermark;
          after = nextWatermark;
        }
        const newItems = mapThreadMessagesToChatMessages(result.items);
        setMessages((current) => {
          // Server copies win on id collision (listed last in the Map).
          const mergedById = new Map(
            [...current, ...newItems].map((message) => [message.id, message]),
          );
          return dropStaleActiveThreadRunMessages(
            Array.from(mergedById.values()).sort(
              (left, right) =>
                new Date(left.createdAt).getTime() -
                new Date(right.createdAt).getTime(),
            ),
          );
        });
        if (!result.nextCursor) {
          break;
        }
      }
    } catch {
      await loadThreadMessages();
    } finally {
      isAppendingRef.current = false;
    }
  }, [activeThreadRunRef, loadThreadMessages, threadId, workspaceId]);

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
    appendNewerThreadMessages,
    isLoadingOlderMessages,
    loadOlderThreadMessages,
    loadThreadMessages,
    mergeStreamingAssistantIntoMessages,
    messages,
    olderMessagesCursor,
    reconcileCommittedArtifactOutputs,
    setMessages,
    setStreamingAssistantSnapshot,
  };
}

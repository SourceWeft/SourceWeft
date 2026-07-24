"use client";

import { useEffect, useRef, type RefObject } from "react";
import { contentClient } from "../../../../../lib/sdk";
import type { ActiveThreadRun } from "../chat-stream-runner-control";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const MESSAGE_REFETCH_DEBOUNCE_MS = 250;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type RoomFrame =
  | { type: "ready" }
  | { type: "resync" }
  | { type: "message"; messageId?: string; role?: string }
  | { type: "run"; kind?: string; runId?: string; status?: string };

type RoomActiveRun = {
  id: string;
  idempotencyKey: string;
  status: "queued" | "running" | "cancel_requested" | "waiting_for_approval";
  mode: "send" | "refresh" | "edit" | "resume";
  userId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  approvalRequestedAt?: string | null;
  approvalExpiresAt?: string | null;
};

function normalizeRoomRun(run: RoomActiveRun): ActiveThreadRun {
  return {
    id: run.id,
    idempotencyKey: run.idempotencyKey,
    status: run.status,
    mode: run.mode,
    userId: run.userId,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    approvalRequestedAt: run.approvalRequestedAt ?? null,
    approvalExpiresAt: run.approvalExpiresAt ?? null,
  };
}

/**
 * Fold a room-reported run into the local active run without clobbering state we
 * own. If it's the same run we already track, only advance its status. If it's a
 * run we drive/attach (our token stream owns its lifecycle), keep our richer
 * local copy. Otherwise adopt it — a member's run (or our own from another tab)
 * — so `chatExecutionState` flips to non-idle and the send-queue engages. The
 * adopted run keeps its `userId`, so owner-aware gating still leaves this
 * member's composer usable.
 */
export function reconcileRoomRun(input: {
  current: ActiveThreadRun | null;
  incoming: ActiveThreadRun;
  attachedRunKey: string | null;
}): ActiveThreadRun {
  const { current, incoming, attachedRunKey } = input;
  if (current && current.idempotencyKey === incoming.idempotencyKey) {
    return current.status === incoming.status
      ? current
      : { ...current, status: incoming.status };
  }
  if (attachedRunKey === incoming.idempotencyKey) {
    return current ?? incoming;
  }
  return incoming;
}

type UseThreadRoomInput = {
  workspaceId: string | null;
  threadId: string;
  currentUserId: string | null;
  activeThreadRunRef: RefObject<ActiveThreadRun | null>;
  attachedRunKeyRef: RefObject<string | null>;
  setActiveThreadRun: (
    updater: (current: ActiveThreadRun | null) => ActiveThreadRun | null,
  ) => void;
  clearRunIfCurrent: (durableRunKey: string) => void;
  loadThreadMessages: () => Promise<void>;
};

/**
 * Subscribes to the thread's live "room" (SSE) and reconciles its ID-only
 * wake-ups against the existing chat state over REST. This is the Phase-2
 * payoff: a member with the thread already open learns another member started a
 * run (so the send-queue engages) and sees new turns without refreshing. It
 * never attaches to a token stream — the existing attach path stays the sole
 * attacher — so it can't disrupt an in-flight render.
 */
export function useThreadRoom({
  workspaceId,
  threadId,
  currentUserId,
  activeThreadRunRef,
  attachedRunKeyRef,
  setActiveThreadRun,
  clearRunIfCurrent,
  loadThreadMessages,
}: UseThreadRoomInput) {
  // Latest callbacks/refs read at fire time so the subscription only re-opens on
  // thread/workspace change, never on a render-to-render identity change.
  const latestRef = useRef({
    currentUserId,
    activeThreadRunRef,
    attachedRunKeyRef,
    setActiveThreadRun,
    clearRunIfCurrent,
    loadThreadMessages,
  });
  latestRef.current = {
    currentUserId,
    activeThreadRunRef,
    attachedRunKeyRef,
    setActiveThreadRun,
    clearRunIfCurrent,
    loadThreadMessages,
  };

  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    const controller = new AbortController();
    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;

    // Only refetch messages while idle — never reset the list mid-stream, which
    // would drop an in-flight assistant render for the driver or a follower.
    const scheduleMessageRefetch = () => {
      if (refetchTimer) {
        return;
      }
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        if (latestRef.current.activeThreadRunRef.current == null) {
          void latestRef.current.loadThreadMessages();
        }
      }, MESSAGE_REFETCH_DEBOUNCE_MS);
    };

    const reconcileRun = async () => {
      let summary: RoomActiveRun | null;
      try {
        const result = await contentClient.getActiveThreadRun(
          workspaceId,
          threadId,
        );
        summary = (result.threadRun as RoomActiveRun | null) ?? null;
      } catch {
        return;
      }
      if (closed) {
        return;
      }
      const deps = latestRef.current;
      if (!summary) {
        // No active run server-side. Clear an adopted remote run; leave our own
        // and attached runs to the existing local lifecycle. Then pull the turn
        // that just finished.
        const current = deps.activeThreadRunRef.current;
        if (current) {
          const isOurs =
            current.userId == null || current.userId === deps.currentUserId;
          const isAttached =
            deps.attachedRunKeyRef.current === current.idempotencyKey;
          if (!isOurs && !isAttached) {
            deps.clearRunIfCurrent(current.idempotencyKey);
          }
        }
        scheduleMessageRefetch();
        return;
      }
      const incoming = normalizeRoomRun(summary);
      deps.setActiveThreadRun((current) =>
        reconcileRoomRun({
          current,
          incoming,
          attachedRunKey: deps.attachedRunKeyRef.current,
        }),
      );
    };

    const handleFrame = (frame: RoomFrame) => {
      if (frame.type === "run") {
        void reconcileRun();
        return;
      }
      if (frame.type === "message") {
        scheduleMessageRefetch();
        return;
      }
      if (frame.type === "ready" || frame.type === "resync") {
        // (Re)connect / gap recovery: reconcile run state and pull messages.
        void reconcileRun();
        scheduleMessageRefetch();
      }
    };

    const connect = async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/workspaces/${workspaceId}/threads/${threadId}/room`,
          { credentials: "include", signal: controller.signal },
        );
        if (!response.ok || !response.body) {
          throw new Error(`Room connect failed (${response.status})`);
        }
        reconnectAttempt = 0;
        // Reconcile immediately on connect so a gap before the first event can't
        // leave stale state.
        void reconcileRun();
        scheduleMessageRefetch();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf("\n\n");
          while (separator !== -1) {
            const rawFrame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const dataLine = rawFrame
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (dataLine) {
              const json = dataLine.slice(dataLine.indexOf(":") + 1).trim();
              if (json) {
                try {
                  handleFrame(JSON.parse(json) as RoomFrame);
                } catch {
                  // Ignore an unparseable frame; the next reconcile corrects it.
                }
              }
            }
            separator = buffer.indexOf("\n\n");
          }
        }
        throw new Error("Room stream ended");
      } catch (error) {
        if (closed || controller.signal.aborted) {
          return;
        }
        void error;
        const delay = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** reconnectAttempt,
        );
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          void connect();
        }, delay);
      }
    };

    void connect();

    return () => {
      closed = true;
      controller.abort();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (refetchTimer) {
        clearTimeout(refetchTimer);
      }
    };
    // Only re-open on thread/workspace change; everything else is read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, threadId]);
}

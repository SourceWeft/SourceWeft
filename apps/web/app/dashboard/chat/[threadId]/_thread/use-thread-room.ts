"use client";

import { useEffect, useRef, type RefObject } from "react";
import { contentClient } from "../../../../../lib/sdk";
import type { ActiveThreadRun } from "../chat-stream-runner-control";
import type { ArtifactOutputReconcileTarget } from "./artifact-output-reconcile";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const MESSAGE_REFETCH_DEBOUNCE_MS = 250;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Degrade-mode polling when the room is at capacity (503). Jittered so N evicted
// clients don't synchronize their polls; re-probe for a free SSE slot every ~2m.
const POLL_BASE_MS = 15_000;
const POLL_REPROBE_TICKS = 8;
const RECENT_ARTIFACT_RECONCILE_MS = 30_000;

type RoomFrame =
  | { type: "ready" }
  | { type: "resync" }
  | { type: "message"; messageId?: string; role?: string }
  | {
      type: "run";
      kind?: string;
      runId?: string;
      status?: string;
      assistantMessageId?: string;
    }
  | { type: "presence"; here?: string[] }
  | { type: "typing"; userId?: string };

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
  // A run we attach/drive is owned by the local streaming flow, whose state is
  // fresher than a room snapshot (which can momentarily lag). Never let the room
  // modify it — return our local copy untouched.
  if (attachedRunKey === incoming.idempotencyKey) {
    return current ?? incoming;
  }
  if (current && current.idempotencyKey === incoming.idempotencyKey) {
    return current.status === incoming.status
      ? current
      : { ...current, status: incoming.status };
  }
  return incoming;
}

/**
 * When the room reports no active run, should we clear the local run here? Only
 * if THIS tab does not locally own its token stream. A run we drive or attach is
 * cleared by that local lifecycle; a run we merely adopted from the room (another
 * member's, or our own from a second tab) has no such lifecycle, so it must be
 * cleared here or chatExecutionState stays "executing" and the queue never drains.
 */
export function shouldClearAdoptedRun(input: {
  isLocallyDriven: boolean;
  isAttached: boolean;
}): boolean {
  return !input.isLocallyDriven && !input.isAttached;
}

/**
 * Fold `incoming` into `current`, treating either identifying field (runId,
 * assistantMessageId) as authoritative: if a field present on BOTH sides
 * disagrees, the remembered target is a different run/message than the one
 * just observed, so drop it entirely and start over from `incoming` rather
 * than splicing its fields onto the stale target. Without this, an update
 * that only carries one field (e.g. an early frame for a new run that only
 * has an assistantMessageId yet) would merge onto a leftover runId from the
 * previous run, producing a target that pairs a fresh id with a stale one —
 * exactly the split-brain that mis-attributes an artifact_output block.
 * A null/undefined field on `incoming` is always treated as "unknown", never
 * as an explicit clear, so it can't clobber a real value already remembered.
 */
export function mergeArtifactOutputTarget(
  current: ArtifactOutputReconcileTarget | null,
  incoming: ArtifactOutputReconcileTarget | null | undefined,
): ArtifactOutputReconcileTarget | null {
  const runId = incoming?.runId ?? undefined;
  const assistantMessageId = incoming?.assistantMessageId ?? undefined;
  if (!runId && !assistantMessageId) {
    return current;
  }
  const runIdConflicts = Boolean(
    runId && current?.runId && runId !== current.runId,
  );
  const messageIdConflicts = Boolean(
    assistantMessageId &&
    current?.assistantMessageId &&
    assistantMessageId !== current.assistantMessageId,
  );
  const base = runIdConflicts || messageIdConflicts ? null : current;
  return {
    ...(base ?? {}),
    ...(runId ? { runId } : {}),
    ...(assistantMessageId ? { assistantMessageId } : {}),
  };
}

export function artifactOutputTargetFromRoomFrame(
  frame: RoomFrame,
): ArtifactOutputReconcileTarget | null {
  if (frame.type !== "run" || (!frame.runId && !frame.assistantMessageId)) {
    return null;
  }
  return {
    ...(frame.runId ? { runId: frame.runId } : {}),
    ...(frame.assistantMessageId
      ? { assistantMessageId: frame.assistantMessageId }
      : {}),
  };
}

type UseThreadRoomInput = {
  workspaceId: string | null | undefined;
  threadId: string;
  activeThreadRunRef: RefObject<ActiveThreadRun | null>;
  attachedRunKeyRef: RefObject<string | null>;
  // Whether THIS tab drives a run's token stream. Used to decide when a
  // room-reported "no active run" should clear the local run — a run we don't
  // locally drive (another member's, or our own from a second tab) must be
  // cleared here, or the send-queue would never drain.
  isStreamingRef: RefObject<boolean>;
  setActiveThreadRun: (
    updater: (current: ActiveThreadRun | null) => ActiveThreadRun | null,
  ) => void;
  clearRunIfCurrent: (durableRunKey: string) => void;
  appendNewerMessages: () => Promise<void>;
  reconcileCommittedArtifactOutputs: (
    target: ArtifactOutputReconcileTarget,
  ) => Promise<void>;
  // Presence/typing: the full viewer roster (userIds) on each presence frame,
  // and one userId per typing frame (already self-filtered server-side).
  onPresence: (here: string[]) => void;
  onTyping: (userId: string) => void;
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
  activeThreadRunRef,
  attachedRunKeyRef,
  isStreamingRef,
  setActiveThreadRun,
  clearRunIfCurrent,
  appendNewerMessages,
  reconcileCommittedArtifactOutputs,
  onPresence,
  onTyping,
}: UseThreadRoomInput) {
  // Latest callbacks/refs read at fire time so the subscription only re-opens on
  // thread/workspace change, never on a render-to-render identity change.
  const latestRef = useRef({
    activeThreadRunRef,
    attachedRunKeyRef,
    isStreamingRef,
    setActiveThreadRun,
    clearRunIfCurrent,
    appendNewerMessages,
    reconcileCommittedArtifactOutputs,
    onPresence,
    onTyping,
  });
  latestRef.current = {
    activeThreadRunRef,
    attachedRunKeyRef,
    isStreamingRef,
    setActiveThreadRun,
    clearRunIfCurrent,
    appendNewerMessages,
    reconcileCommittedArtifactOutputs,
    onPresence,
    onTyping,
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
    let recentArtifactTarget: ArtifactOutputReconcileTarget | null = null;
    let recentArtifactTargetExpiresAt = 0;
    // Latest-wins guard: a run's terminal frame fires the last reconcile, and
    // its (null) result must win even if an earlier "running" fetch resolves
    // afterward — otherwise a stale response re-adopts a finished run and the
    // send-queue never drains.
    let reconcileSeq = 0;

    const targetFromActiveRun = (): ArtifactOutputReconcileTarget | null => {
      const active = latestRef.current.activeThreadRunRef.current;
      if (!active?.id && !active?.assistantMessageId) {
        return null;
      }
      return {
        ...(active.id ? { runId: active.id } : {}),
        ...(active.assistantMessageId
          ? { assistantMessageId: active.assistantMessageId }
          : {}),
      };
    };

    const rememberArtifactTarget = (
      target: ArtifactOutputReconcileTarget | null,
    ) => {
      if (!target?.runId && !target?.assistantMessageId) {
        return;
      }
      recentArtifactTarget = mergeArtifactOutputTarget(
        recentArtifactTarget,
        target,
      );
      recentArtifactTargetExpiresAt = Date.now() + RECENT_ARTIFACT_RECONCILE_MS;
    };

    const reconcileArtifactOutputs = (
      preferred?: ArtifactOutputReconcileTarget | null,
    ) => {
      const active = targetFromActiveRun();
      // Fold active/preferred in through the same conflict-aware merge used to
      // persist recentArtifactTarget — building the call's target with a plain
      // spread here would silently splice a fresh runId onto a stale
      // assistantMessageId (or vice versa) before rememberArtifactTarget ever
      // gets a chance to detect the conflict.
      rememberArtifactTarget(active);
      rememberArtifactTarget(preferred ?? null);
      const target =
        recentArtifactTarget && Date.now() <= recentArtifactTargetExpiresAt
          ? recentArtifactTarget
          : null;
      if (!target?.runId && !target?.assistantMessageId) {
        return;
      }
      void latestRef.current.reconcileCommittedArtifactOutputs(target);
    };

    // Only refetch messages while idle — never reset the list mid-stream, which
    // would drop an in-flight assistant render for the driver or a follower.
    const scheduleMessageRefetch = () => {
      if (refetchTimer) {
        return;
      }
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        if (latestRef.current.activeThreadRunRef.current == null) {
          void latestRef.current.appendNewerMessages();
        }
      }, MESSAGE_REFETCH_DEBOUNCE_MS);
    };

    const reconcileRun = async () => {
      const seq = ++reconcileSeq;
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
      // Drop a stale/out-of-order response: only the newest-issued reconcile
      // applies its result.
      if (closed || seq !== reconcileSeq) {
        return;
      }
      const deps = latestRef.current;
      if (!summary) {
        // No active run server-side. Clear the local run unless THIS tab drives
        // its token stream (streaming or attached) — that lifecycle clears it
        // itself. This drains another member's run AND our own run adopted from
        // a second tab; leaving it set would wedge chatExecutionState at
        // "executing" and the send-queue would never fire.
        const current = deps.activeThreadRunRef.current;
        rememberArtifactTarget(
          current
            ? {
                ...(current.id ? { runId: current.id } : {}),
                ...(current.assistantMessageId
                  ? { assistantMessageId: current.assistantMessageId }
                  : {}),
              }
            : null,
        );
        if (
          current &&
          shouldClearAdoptedRun({
            isLocallyDriven: deps.isStreamingRef.current === true,
            isAttached:
              deps.attachedRunKeyRef.current === current.idempotencyKey,
          })
        ) {
          deps.clearRunIfCurrent(current.idempotencyKey);
        }
        scheduleMessageRefetch();
        return;
      }
      const incoming = normalizeRoomRun(summary);
      rememberArtifactTarget({
        runId: incoming.id,
        assistantMessageId: incoming.assistantMessageId,
      });
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
        const artifactTarget = artifactOutputTargetFromRoomFrame(frame);
        rememberArtifactTarget(artifactTarget);
        if (frame.kind === "artifact_output" || frame.kind === "run_finished") {
          reconcileArtifactOutputs(artifactTarget);
        }
        void reconcileRun();
        return;
      }
      if (frame.type === "message") {
        scheduleMessageRefetch();
        return;
      }
      if (frame.type === "presence") {
        latestRef.current.onPresence(frame.here ?? []);
        // The room's existing 15s presence heartbeat is also the bounded repair
        // path for a dropped best-effort NotifyHub artifact wake-up.
        reconcileArtifactOutputs();
        return;
      }
      if (frame.type === "typing") {
        if (frame.userId) {
          latestRef.current.onTyping(frame.userId);
        }
        return;
      }
      if (frame.type === "ready" || frame.type === "resync") {
        // (Re)connect / gap recovery: reconcile run state and pull messages.
        // The server re-emits the presence snapshot right after ready, so no
        // presence handling is needed here.
        void reconcileRun().then(() => reconcileArtifactOutputs());
        scheduleMessageRefetch();
      }
    };

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollTicks = 0;
    // Single connect driver: only one connect attempt / live stream at a time,
    // so a poller re-probe and a reconnect timer can't open two SSE streams
    // (two hub slots) for one client.
    let connecting = false;
    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const startPolling = () => {
      if (pollTimer || closed) {
        return;
      }
      pollTicks = 0;
      // ±20% jitter so a wave of evicted clients doesn't poll in lockstep.
      const interval = Math.round(
        POLL_BASE_MS * (1 + (Math.random() * 0.4 - 0.2)),
      );
      pollTimer = setInterval(() => {
        if (closed) {
          stopPolling();
          return;
        }
        void reconcileRun().then(() => reconcileArtifactOutputs());
        scheduleMessageRefetch();
        pollTicks += 1;
        if (pollTicks % POLL_REPROBE_TICKS === 0) {
          // Try to reclaim a live SSE slot; connect() stops the poller on success.
          void connect();
        }
      }, interval);
    };

    const connect = async () => {
      if (connecting || closed) {
        return;
      }
      connecting = true;
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/workspaces/${workspaceId}/threads/${threadId}/room`,
          { credentials: "include", signal: controller.signal },
        );
        if (response.status === 503) {
          // Room at capacity — degrade to low-frequency polling.
          startPolling();
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`Room connect failed (${response.status})`);
        }
        reconnectAttempt = 0;
        stopPolling();
        // Reconcile immediately on connect so a gap before the first event can't
        // leave stale state.
        void reconcileRun().then(() => reconcileArtifactOutputs());
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
        // While the poller owns reconnection, a failed re-probe is retried by
        // the next poll tick — don't also start the exponential reconnect chain
        // (that would run two reconnect drivers in parallel).
        if (pollTimer) {
          return;
        }
        const delay = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** reconnectAttempt,
        );
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          void connect();
        }, delay);
      } finally {
        connecting = false;
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
      stopPolling();
    };
    // Only re-open on thread/workspace change; everything else is read from refs.
  }, [workspaceId, threadId]);
}
